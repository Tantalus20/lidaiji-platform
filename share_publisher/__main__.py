"""长文分享发布器 CLI（timer 唤醒 → 执行 → 退出，不常驻）。

用法：
  python -m share_publisher --project-root <仓库根> run-once
  python -m share_publisher --project-root <仓库根> dry-run [--publication <id>]
  python -m share_publisher --project-root <仓库根> status
  python -m share_publisher --project-root <仓库根> cancel <publication_id>
  python -m share_publisher --project-root <仓库根> create <share_id> --summary <文本> [--at <ISO时间>]

环境变量：
  LIDAIJI_SHARE_CONTENT_ROOT  分享私有内容根（缺省为仓库上一级 lidaiji-share-private）
  SHARE_BASE_URL              分享站 baseURL（缺省 http://localhost:1314/）
  SHARE_DIST                  构建输出根（缺省 <仓库>/dist）
  QZONE_PUBLISH_ENABLED       QQ 自动发布总开关（缺省 false；true 才会联网）
  NAPCAT_HTTP_URL / NAPCAT_QQ NapCat 与目标 QQ（仅启用时使用）

安全：
  - 默认绝不真实发布；dry-run 全程只读，不发任何网络请求；
  - 失败后停止，绝不自动重试；同一 publication 原子认领只执行一次；
  - 所有日志经 qzone.redact() 脱敏。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

from share_publisher import db as pubdb  # noqa: E402
from share_publisher import qzone as qzone_mod  # noqa: E402
from share_publisher import web as web_stage  # noqa: E402
from share_publisher.artifacts import (  # noqa: E402
    ArtifactError,
    page_names,
    read_manifest,
    safe_resolve,
    verify_artifact,
)


def _env(key: str, default: str = "") -> str:
    import os

    return os.environ.get(key, default) or default


def resolve_paths(project_root: Path) -> tuple[Path, Path, str, Path]:
    """返回 (share_root, dist_root, base_url, db_path)。"""
    from studio import share

    share_root = share.share_root(project_root)
    dist_root = Path(_env("SHARE_DIST", str(project_root / "dist"))).resolve()
    base_url = _env("SHARE_BASE_URL", "http://localhost:1314/")
    db_path = share_root / "publications.sqlite3"
    return share_root, dist_root, base_url, db_path


def build_adapter() -> qzone_mod.QzoneAdapter:
    config = qzone_mod.QzoneAdapterConfig(
        napcat_http_url=_env("NAPCAT_HTTP_URL"),
        qq_account=_env("NAPCAT_QQ"),
        access_token=_env("NAPCAT_ACCESS_TOKEN"),
        visibility=_env("SHARE_QZONE_VISIBILITY", "public"),  # public/friends/self
    )
    return qzone_mod.QzoneAdapter(config)


def run_web_stage(project_root: Path, db: pubdb.PublisherDB, share_root: Path, base_url: str, dist_root: Path) -> None:
    pending = db.list_pending_web()
    if not pending:
        return
    build = web_stage.build_share_site(project_root, share_root, base_url, dist_root)
    if not build["success"]:
        tail = build["output"][-1500:]
        for record in pending:
            db.mark_web_failed(record["publication_id"], "web-build-failed", f"分享站构建失败：{tail}")
        print(f"网页阶段失败：{len(pending)} 个任务标记失败（构建错误）。")
        return
    for record in pending:
        if not db.claim_web(record["publication_id"]):
            continue
        try:
            slug = web_stage.read_slug(share_root, record["share_id"])
            url = web_stage.canonical_url(base_url, slug)
        except Exception as error:
            db.mark_web_failed(record["publication_id"], "web-item-missing", f"无法读取分享项：{error}")
            continue
        if web_stage.page_in_manifest(build["manifest"], slug):
            db.mark_web_verified(record["publication_id"], url)
            print(f"网页已发布并验证：{url}")
        else:
            db.mark_web_failed(
                record["publication_id"], "web-url-not-found", f"构建产物中找不到页面 {slug}/"
            )
            print(f"网页验证失败：{record['publication_id']}（缺少 {slug}/）")


def run_qzone_stage(db: pubdb.PublisherDB, base_url: str, share_root: Path, adapter_factory=None, readback=None) -> None:
    due = db.list_due()
    if not due:
        return
    if not qzone_mod.adapter_enabled():
        for record in due:
            db.mark_skipped(
                record["publication_id"],
                "qzone-disabled",
                "QZONE_PUBLISH_ENABLED=false，QQ 自动发布未启用；网页发布不受影响。",
            )
        print(f"QQ 阶段跳过：QZONE_PUBLISH_ENABLED=false（{len(due)} 个到期任务标记为 skipped）。")
        return
    adapter = adapter_factory() if adapter_factory else build_adapter()
    for record in due:
        if not db.claim_qzone(record["publication_id"]):
            continue
        if pubdb.text_length(record["final_text"]) > pubdb.QQ_TEXT_MAX:
            db.mark_failed(
                record["publication_id"],
                "text-too-long",
                f"QQ 文案超长（{pubdb.text_length(record['final_text'])} 字，上限 {pubdb.QQ_TEXT_MAX}）。",
            )
            continue
        try:
            cookie = adapter.fetch_cookie()
            if record["mode"] in (pubdb.MODE_IMAGE_EXCERPT, pubdb.MODE_IMAGE_FULL):
                pic_ids = _upload_publication_images(adapter, cookie, record, share_root)
                outcome = adapter.publish_text_with_images(record["final_text"], cookie, pic_ids)
            else:
                outcome = adapter.publish_text(record["final_text"], cookie)
        except qzone_mod.QzoneAdapterError as error:
            if error.code == "qzone-ambiguous":
                # 请求可能已到达 QQ：绝不标 failed（否则用户可能误以为没发而重发）。
                db.mark_submitted(
                    record["publication_id"],
                    code="ambiguous-submission",
                    message="QZone 连接中断/超时，无法确认是否已接收；请人工确认，切勿直接重发。",
                )
                print(f"QQ 结果未知（{record['publication_id']}）：{error.message}（待人工确认）。")
            else:
                db.mark_failed(record["publication_id"], error.code, error.message)
                print(f"QQ 发布失败（{record['publication_id']}）：{error.message}（不再自动重试）。")
            continue
        if outcome.post_id:
            if readback is not None and readback(outcome.post_id):
                db.mark_published(record["publication_id"], outcome.post_id)
                print(f"QQ 已发布并反查确认（{record['publication_id']}）：{outcome.post_id}")
            else:
                db.mark_submitted(record["publication_id"], outcome.post_id, code="")
                print(f"QQ 已提交待反查（{record['publication_id']}）：{outcome.message}")
        else:
            db.mark_submitted(record["publication_id"], code="no-post-id")
            print(f"QQ 已提交待反查（{record['publication_id']}）：{outcome.message}")
        db.touch_attempt(record["publication_id"])


def _upload_publication_images(adapter, cookie, record, share_root: Path) -> list[str]:
    """按 publication 快照上传图片（图片节选只取前 N 张）。

    返回 pic_id 列表；上传中途失败抛出 QzoneAdapterError（由调用方标 failed，
    绝不发布残缺说说）。图片节选数量由 SHARE_IMAGE_EXCERPT_COUNT 决定。
    """
    import json as _json

    metadata = _json.loads(record.get("metadata_json") or "{}")
    artifact_mode = metadata.get("artifactMode", "cards")
    if artifact_mode == "long-cards":
        names = _verify_long_snapshot(share_root, record)
    else:
        manifest = read_manifest(share_root, record["share_id"], record["share_revision"])
        if manifest.get("shareRevision") != record["share_revision"]:
            raise qzone_mod.QzoneAdapterError(
                "artifact-stale", "图片 artifact 与发布任务快照不一致，请重新生成图片后新建任务。"
            )
        errors = verify_artifact(share_root, record["share_id"], record["share_revision"])
        if errors:
            raise qzone_mod.QzoneAdapterError("artifact-corrupt", "；".join(errors))
        names = page_names(manifest)
        if record["mode"] == pubdb.MODE_IMAGE_EXCERPT:
            names = names[: _IMAGE_EXCERPT_COUNT()]
        names = names[: _IMAGE_MAX_COUNT()]
    # 上传前的统一硬门：任何路径最终图片数都不得高于 9（绝不先上传再检查）
    if len(names) > _IMAGE_MAX_COUNT():
        raise qzone_mod.QzoneAdapterError(
            "too-many-images", f"最终图片数 {len(names)} 超过 QQ 安全上限 {_IMAGE_MAX_COUNT()}。"
        )
    pic_ids: list[str] = []
    for name in names:
        target = safe_resolve(
            share_root,
            record["share_id"],
            record["share_revision"],
            name,
            long=(artifact_mode == "long-cards"),
        )
        pic_ids.append(adapter.upload_image(target.read_bytes(), cookie))
        print(f"上传图片: {name}（{target.stat().st_size} 字节，来自 {'长图' if artifact_mode == 'long-cards' else '卡片'} artifact）")
    return pic_ids


def _verify_long_snapshot(share_root, record) -> list[str]:
    """长图发布前完整性校验（任务书 §十一）：

    1. 长图 manifest 存在且 shareRevision 一致；
    2. sourceArtifactHash 与当前 cards manifest 哈希一致（未 stale）；
    3. 每张最终图片 SHA 与 manifest 一致（PUBLICATION_SNAPSHOT_TAMPERED）；
    4. 图片数 ≤9；顺序 = publishImages.index 顺序；无额外图片。
    """
    from share_publisher.artifacts import (
        MANIFEST_NAME,
        artifact_dir,
        long_artifact_dir,
        long_stale,
        read_long_manifest,
        safe_resolve,
        sha256_file,
    )

    manifest = read_long_manifest(share_root, record["share_id"], record["share_revision"])
    if manifest.get("shareRevision") != record["share_revision"]:
        raise qzone_mod.QzoneAdapterError("artifact-stale", "长图与发布任务快照不一致。")
    cards_hash = sha256_file(artifact_dir(share_root, record["share_id"], record["share_revision"]) / MANIFEST_NAME)
    if long_stale(manifest, record["share_revision"], cards_hash):
        raise qzone_mod.QzoneAdapterError("artifact-stale", "长图已过期，请重新生成。")
    images = manifest.get("publishImages", [])
    if not images or len(images) > _IMAGE_MAX_COUNT():
        raise qzone_mod.QzoneAdapterError("too-many-images", f"长图 {len(images)} 张超过安全上限。")
    names: list[str] = []
    for img in images:
        name = f"{img['index']:02d}.png"
        names.append(name)
        try:
            target = safe_resolve(share_root, record["share_id"], record["share_revision"], name, long=True)
            if sha256_file(target) != img.get("sha256"):
                raise qzone_mod.QzoneAdapterError(
                    "PUBLICATION_SNAPSHOT_TAMPERED", f"长图 {name} 哈希不一致，拒绝发布。"
                )
        except (FileNotFoundError, qzone_mod.QzoneAdapterError) as error:
            if isinstance(error, qzone_mod.QzoneAdapterError):
                raise
            raise qzone_mod.QzoneAdapterError("PUBLICATION_SNAPSHOT_TAMPERED", f"长图 {name} 缺失。") from error
    # 冻结快照中的图片名与当前一致（无额外图片）
    frozen_names = metadata_image_names(record)
    if frozen_names and frozen_names != names:
        raise qzone_mod.QzoneAdapterError(
            "PUBLICATION_SNAPSHOT_TAMPERED", "长图清单与发布任务快照不一致，拒绝发布。"
        )
    return names


def metadata_image_names(record) -> list[str] | None:
    import json as _json

    metadata = _json.loads(record.get("metadata_json") or "{}")
    names = metadata.get("imageNames")
    return names if isinstance(names, list) else None


def _IMAGE_EXCERPT_COUNT() -> int:
    import os

    return int(os.environ.get("SHARE_IMAGE_EXCERPT_COUNT", "6"))


def _IMAGE_MAX_COUNT() -> int:
    """QQ 单条说说图片上限（真机实测 9）；任何路径都不得高于 9。"""
    import os

    return min(9, max(1, int(os.environ.get("SHARE_IMAGE_MAX_COUNT", "9"))))


def cmd_run_once(project_root: Path) -> int:
    share_root, dist_root, base_url, db_path = resolve_paths(project_root)
    with pubdb.PublisherDB(db_path) as db:
        recovered = db.recover_stale_claims()
        for publication_id in recovered:
            print(f"崩溃恢复：{publication_id} 已标记失败（拒绝重复发布）。")
        run_web_stage(project_root, db, share_root, base_url, dist_root)
        run_qzone_stage(db, base_url, share_root)
    return 0


def cmd_dry_run(project_root: Path, publication_id: str = "") -> int:
    share_root, _dist, base_url, db_path = resolve_paths(project_root)
    with pubdb.PublisherDB(db_path) as db:
        if publication_id:
            records = [record for record in [db.get(publication_id)] if record]
        else:
            records = db.list_due()
        if not records:
            print("没有到期的发布任务。")
            return 0
        for record in records:
            print(f"publication: {record['publication_id']}")
            print(f"share revision: {record['share_revision']}")
            print(f"content hash: {record['content_hash']}")
            print(f"target URL: {record['canonical_url'] or _pending_url(share_root, base_url, record)}")
            print(f"scheduled at: {record['scheduled_at']}")
            print(f"web status: {record['web_status']} | qzone status: {record['qzone_status']}")
            print(f"text length: {pubdb.text_length(record['final_text'])}")
            print("final text:")
            print(record["final_text"])
            print("---")
    return 0


def _pending_url(share_root: Path, base_url: str, record: dict) -> str:
    try:
        slug = web_stage.read_slug(share_root, record["share_id"])
        return web_stage.canonical_url(base_url, slug)
    except Exception:
        return "（无法确定）"


def cmd_status(project_root: Path) -> int:
    _share, _dist, _base, db_path = resolve_paths(project_root)
    with pubdb.PublisherDB(db_path) as db:
        records = db.list_all()
        if not records:
            print("（没有发布记录）")
            return 0
        print(f"{'publication_id':<22} {'share_id':<20} {'web':<9} {'qzone':<22} scheduled_at")
        for record in records:
            print(
                f"{record['publication_id']:<22} {record['share_id']:<20} "
                f"{record['web_status']:<9} {record['qzone_status']:<22} {record['scheduled_at']}"
            )
    return 0


def cmd_cancel(project_root: Path, publication_id: str) -> int:
    _share, _dist, _base, db_path = resolve_paths(project_root)
    with pubdb.PublisherDB(db_path) as db:
        if db.cancel(publication_id):
            print(f"已取消：{publication_id}（网页发布结果不回滚）。")
            return 0
        record = db.get(publication_id)
        if record is None:
            print(f"找不到任务：{publication_id}")
            return 1
        print(f"无法取消（当前 qzone 状态 {record['qzone_status']}）：{publication_id}")
        return 1


def cmd_confirm(project_root: Path, publication_id: str) -> int:
    """人工确认：只在 submitted_unverified 时转 published（幂等）。"""
    _share, _dist, _base, db_path = resolve_paths(project_root)
    with pubdb.PublisherDB(db_path) as db:
        ok, state = db.confirm_publication(publication_id, confirmed_by="cli-manual")
        if not ok:
            print(f"无法确认：{state}", file=sys.stderr)
            return 1
        record = db.get(publication_id)
        if state == "already-published":
            print(f"该任务已是 published（幂等，未重复确认）：{publication_id}")
        else:
            print(f"已人工确认并标记 published：{publication_id}")
            print(f"确认时间：{record['confirmed_at']}（确认人：cli-manual）")
            print(f"说说标识：{record['qzone_post_id'] or '—'}")
    return 0


def cmd_create(project_root: Path, share_id: str, summary: str, scheduled_at: str) -> int:
    share_root, _dist, base_url, db_path = resolve_paths(project_root)
    if not summary.strip():
        print("摘要不能为空。", file=sys.stderr)
        return 1
    try:
        slug = web_stage.read_slug(share_root, share_id)
    except Exception as error:
        print(f"分享项不可用：{error}", file=sys.stderr)
        return 1
    from studio import share as share_mod

    record = None
    for entry in share_mod.scan_shares(project_root):
        if entry["shareId"] == share_id:
            record = entry
            break
    if record is None:
        print(f"找不到分享项：{share_id}", file=sys.stderr)
        return 1
    item = share_mod.read_share(project_root, record["path"])
    url = web_stage.canonical_url(base_url, slug)
    final_text = pubdb.final_text_for(summary, url)
    try:
        created = pubdb.PublisherDB(db_path).create(
            share_id=share_id,
            share_revision=record["shareRevision"],
            content_hash=share_mod.content_hash(item["body"]),
            final_text=final_text,
            scheduled_at=scheduled_at,
            metadata={"source": "cli"},
        )
    except pubdb.PublisherError as error:
        print(f"创建失败：{error.message}", file=sys.stderr)
        return 1
    print(f"已创建发布任务：{created['publication_id']}")
    print(f"网页地址：{url}")
    print(f"QQ 文案（{pubdb.text_length(final_text)} 字）：\n{final_text}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="share_publisher", description="长文分享 QQ 空间发布器。")
    parser.add_argument("--project-root", type=Path, default=ROOT, help="《历代纪》仓库根目录")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("run-once", help="执行一次：恢复残留 → 网页阶段 → QQ 阶段")
    dry = sub.add_parser("dry-run", help="只读演练：到期任务与最终文案，绝不联网")
    dry.add_argument("--publication", default="", help="只看指定 publication_id")
    sub.add_parser("status", help="列出全部发布记录")
    cancel = sub.add_parser("cancel", help="取消任务（网页结果不回滚）")
    cancel.add_argument("publication_id")
    confirm = sub.add_parser("confirm", help="人工确认说说真实存在（submitted_unverified → published）")
    confirm.add_argument("publication_id")
    create = sub.add_parser("create", help="创建发布任务")
    create.add_argument("share_id")
    create.add_argument("--summary", required=True, help="QQ 空间摘要正文")
    create.add_argument("--at", default="now", help="发布时间（ISO 时间，缺省立即）")

    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    sys.path.insert(0, str(project_root))

    if args.command == "run-once":
        return cmd_run_once(project_root)
    if args.command == "dry-run":
        return cmd_dry_run(project_root, args.publication)
    if args.command == "status":
        return cmd_status(project_root)
    if args.command == "cancel":
        return cmd_cancel(project_root, args.publication_id)
    if args.command == "confirm":
        return cmd_confirm(project_root, args.publication_id)
    if args.command == "create":
        scheduled = pubdb.to_utc_iso(pubdb.utcnow()) if args.at == "now" else args.at
        return cmd_create(project_root, args.share_id, args.summary, scheduled)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
