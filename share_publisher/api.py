"""Studio 与分享发布器之间的服务层：创建/列表/取消发布任务 + 网页阶段执行。

正文权威仍是磁盘 Markdown；本模块只处理调度记录。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "importer") not in sys.path:
    sys.path.insert(0, str(ROOT / "importer"))

from share_publisher import db as pubdb  # noqa: E402
from share_publisher import qzone as qzone_mod  # noqa: E402
from share_publisher import web as web_stage  # noqa: E402


class SharePublishError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _image_excerpt_count() -> int:
    import os

    return max(1, int(os.environ.get("SHARE_IMAGE_EXCERPT_COUNT", "6")))


def _read_long_for_publish(share_root, share_id, share_revision) -> dict:
    """读取长图 artifact 并做发布前完整性校验（返回 long manifest）。

    校验：manifest 存在且未 stale（sourceArtifactHash 与当前 cards manifest 一致）、
    每张最终图片 SHA 与 manifest 一致、图片数 ≤ 9。失败抛 SharePublishError。
    """
    from share_publisher import artifacts

    try:
        manifest = artifacts.read_long_manifest(share_root, share_id, share_revision)
    except artifacts.ArtifactError as error:
        raise SharePublishError(
            "long-not-generated",
            "原始分页超过 9 张：请先在 Studio「生成长图」后再发布全文图片。",
        ) from error
    cards_hash = artifacts.sha256_file(
        artifacts.artifact_dir(share_root, share_id, share_revision) / artifacts.MANIFEST_NAME
    )
    if artifacts.long_stale(manifest, share_revision, cards_hash):
        raise SharePublishError("artifact-stale", "长图已过期（正文或分页已变化），请重新生成。")
    images = manifest.get("publishImages", [])
    if not images or len(images) > _image_max_count():
        raise SharePublishError("too-many-images", f"长图 {len(images)} 张超过 QQ 安全上限 {_image_max_count()}。")
    for img in images:
        name = f"{img['index']:02d}.png"
        try:
            target = artifacts.safe_resolve(share_root, share_id, share_revision, name)
            if artifacts.sha256_file(target) != img.get("sha256"):
                raise SharePublishError(
                    "PUBLICATION_SNAPSHOT_TAMPERED",
                    f"长图 {name} 与 manifest 哈希不一致，已拒绝发布。",
                )
        except artifacts.ArtifactError as error:
            raise SharePublishError("PUBLICATION_SNAPSHOT_TAMPERED", f"长图 {name} 缺失或不可读。") from error
    return manifest


def _image_max_count() -> int:
    """QQ 单条说说图片上限（真机实测：>9 会被拆成多条单图说说）→ 硬上限 9。"""
    import os

    return min(9, max(1, int(os.environ.get("SHARE_IMAGE_MAX_COUNT", "9"))))


class SharePublicationService:
    def __init__(self, project_root: Path):
        from studio import share

        self.project_root = Path(project_root).resolve()
        self.share_root = share.share_root(self.project_root)
        self.base_url = os.environ.get("SHARE_BASE_URL", "http://localhost:1314/")
        self.dist_root = Path(os.environ.get("SHARE_DIST", str(self.project_root / "dist"))).resolve()
        self.db = pubdb.PublisherDB(self.share_root / "publications.sqlite3")

    def close(self) -> None:
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    # -- 状态 ------------------------------------------------------------

    def status(self) -> dict:
        return {
            "baseUrl": self.base_url,
            "qzoneEnabled": qzone_mod.adapter_enabled(),
            "qzoneConfigured": bool(os.environ.get("NAPCAT_HTTP_URL")) and bool(os.environ.get("NAPCAT_QQ")),
        }

    # -- 列表 ------------------------------------------------------------

    def list_publications(self) -> list[dict]:
        from studio import share

        shares = {entry["shareId"]: entry for entry in share.scan_shares(self.project_root)}
        records = self.db.list_all()
        for record in records:
            entry = shares.get(record["share_id"])
            record["shareTitle"] = entry["title"] if entry else ""
            record["shareDraft"] = entry["draft"] if entry else None
        return records

    # -- 创建 ------------------------------------------------------------

    def create(
        self,
        rel_path: str,
        final_text: str,
        scheduled_at: str,
        mode: str = pubdb.MODE_TEXT_LINK,
        artifact_manifest_hash: str = "",
    ) -> dict:
        from studio import share

        from share_publisher import artifacts

        item = share.read_share(self.project_root, rel_path)
        data = item["frontMatter"]
        share_id = str(data.get("shareId") or "")
        if not share_id:
            raise SharePublishError("validation-failed", "分享缺少 shareId。")
        slug = str(data.get("slug") or "").strip()
        if not slug:
            raise SharePublishError("validation-failed", "分享缺少 slug。")
        final_text = str(final_text or "").strip()
        if not final_text:
            raise SharePublishError("validation-failed", "QQ 空间最终文案不能为空。")
        if pubdb.text_length(final_text) > pubdb.QQ_TEXT_MAX:
            raise SharePublishError(
                "validation-failed",
                f"QQ 最终文案过长（{pubdb.text_length(final_text)} 字，上限 {pubdb.QQ_TEXT_MAX} 字），请精简。",
            )
        # 网页发布 = 转为非草稿（正文与 revision 不变，仅 draft 翻转为 false）
        if bool(data.get("draft")):
            fields = {key: data.get(key) for key in share.EDITABLE_FIELDS}
            fields["draft"] = False
            share.save_share(self.project_root, rel_path, fields, item["body"])

        url = web_stage.canonical_url(self.base_url, slug)
        metadata: dict = {"source": "studio", "slug": slug}
        image_hashes: list[str] = []
        if mode in (pubdb.MODE_IMAGE_EXCERPT, pubdb.MODE_IMAGE_FULL):
            # 图片模式：冻结 artifact（manifest 哈希 + 逐图哈希），禁止旧 revision 图片
            share_revision = str(data.get("shareRevision") or "")
            manifest = artifacts.read_manifest(self.share_root, share_id, share_revision)
            if artifacts.is_stale(manifest, share_revision):
                raise SharePublishError(
                    "artifact-stale",
                    "图片已过期（正文已修改），请重新生成图片后再发布。",
                )
            actual_hash = artifacts.sha256_file(
                artifacts.artifact_dir(self.share_root, share_id, share_revision) / artifacts.MANIFEST_NAME
            )
            if artifact_manifest_hash and actual_hash != artifact_manifest_hash:
                raise SharePublishError(
                    "artifact-changed",
                    "图片 manifest 与预览不一致，请重新生成后再发布。",
                )
            errors = artifacts.verify_artifact(self.share_root, share_id, share_revision)
            if errors:
                raise SharePublishError("artifact-corrupt", "；".join(errors))
            limit = _image_max_count()
            artifact_mode = "cards"
            frozen_manifest_hash = artifact_manifest_hash or actual_hash
            if manifest.get("pageCount", 0) > limit and mode == pubdb.MODE_IMAGE_FULL:
                # V0.3：>9 页全文 → 使用长图 artifact（最终图片 ≤9）
                long_manifest = _read_long_for_publish(self.share_root, share_id, share_revision)
                long_hash = artifacts.sha256_file(
                    artifacts.long_artifact_dir(self.share_root, share_id, share_revision) / artifacts.MANIFEST_NAME
                )
                if artifact_manifest_hash and artifact_manifest_hash != long_hash:
                    raise SharePublishError(
                        "artifact-changed",
                        "长图 manifest 与预览不一致，请重新生成后再发布。",
                    )
                frozen_manifest_hash = long_hash
                names = [f"{img['index']:02d}.png" for img in long_manifest.get("publishImages", [])]
                if len(names) > limit:
                    raise SharePublishError(
                        "too-many-images",
                        f"长图 {len(names)} 张仍超过 QQ 单条安全上限 {limit} 张。",
                    )
                artifact_mode = "long-cards"
            elif mode == pubdb.MODE_IMAGE_EXCERPT:
                excerpt = min(_image_excerpt_count(), manifest.get("pageCount", 0))
                if excerpt > limit:
                    raise SharePublishError(
                        "too-many-images",
                        f"图片节选 {excerpt} 张超过 QQ 单条安全上限 {limit} 张。",
                    )
                names = artifacts.page_names(manifest)[: excerpt]
            else:
                names = artifacts.page_names(manifest)[: limit]
            for name in names:
                target = artifacts.safe_resolve(self.share_root, share_id, share_revision, name)
                image_hashes.append(artifacts.sha256_file(target))
            metadata["artifactMode"] = artifact_mode
            metadata["imageNames"] = names
            artifact_manifest_hash = frozen_manifest_hash

        try:
            record = self.db.create(
                share_id=share_id,
                share_revision=str(data.get("shareRevision") or ""),
                content_hash=share.content_hash(item["body"]),
                final_text=final_text,
                scheduled_at=scheduled_at,
                canonical_url=url,
                metadata=metadata,
                mode=mode,
                artifact_manifest_hash=artifact_manifest_hash,
                image_hashes=image_hashes,
            )
        except pubdb.PublisherError as error:
            raise SharePublishError(error.code, error.message) from error

        # 网页阶段立即执行：构建候选 → 验证 URL → 记录结果（不部署生产）
        web_result = self._run_web_stage_for(record["publication_id"])
        return {
            "publication": self.db.get(record["publication_id"]),
            "url": url,
            "webStage": web_result,
        }

    def _run_web_stage_for(self, publication_id: str) -> dict:
        record = self.db.get(publication_id)
        if record is None or record["web_status"] != pubdb.WEB_PENDING:
            return {"stage": "skipped", "message": "网页阶段已处理或不存在。"}
        build = web_stage.build_share_site(self.project_root, self.share_root, self.base_url, self.dist_root)
        if not build["success"]:
            self.db.mark_web_failed(
                publication_id, "web-build-failed", f"分享站构建失败：{build['output'][-1200:]}"
            )
            return {"stage": "failed", "message": "分享站构建失败，详见发布记录。"}
        try:
            slug = web_stage.read_slug(self.share_root, record["share_id"])
            url = web_stage.canonical_url(self.base_url, slug)
        except Exception as error:
            self.db.mark_web_failed(publication_id, "web-item-missing", str(error))
            return {"stage": "failed", "message": f"无法读取分享项：{error}"}
        if not web_stage.page_in_manifest(build["manifest"], slug):
            self.db.mark_web_failed(
                publication_id, "web-url-not-found", f"构建产物中找不到页面 {slug}/"
            )
            return {"stage": "failed", "message": f"分享站验证失败：页面 {slug}/ 未出现在构建产物中。"}
        self.db.mark_web_verified(publication_id, url)
        return {"stage": "verified", "message": f"网页候选已生成并验证：{url}"}

    # -- 取消 ------------------------------------------------------------

    def cancel(self, publication_id: str) -> bool:
        if self.db.cancel(publication_id):
            return True
        record = self.db.get(publication_id)
        if record is None:
            raise SharePublishError("not-found", "找不到这个发布任务。")
        raise SharePublishError(
            "validation-failed", f"该任务当前状态（{record['qzone_status']}）无法取消。"
        )

    def get(self, publication_id: str) -> dict | None:
        return self.db.get(publication_id)
