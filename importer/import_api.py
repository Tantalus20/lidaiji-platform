#!/usr/bin/env python3
"""DOCX 导入的机器接口：inspect / plan / commit 三个子命令。

人可以直接使用，脚本可以消费 JSON，作者台也可以直接 import 同名函数
（inspect_docx / plan_docx / commit_plan）。所有JSON输出只含项目相对路径，
不含临时绝对路径或本机目录结构。

退出码：0=成功；2=输入文件问题；3=校验失败；4=冲突；5=写入失败；1=其他内部错误。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from import_stages import (  # noqa: E402
    ImportFailure,
    ImportOptions,
    ImportPlan,
    ParseResult,
    assistant_slugify,
    commit_import,
    parse_docx,
    plan_import,
    split_values,
    suggest,
)

EXIT_CODES = {
    "invalid-source": 2,
    "validation-failed": 3,
    "confirmation-required": 3,
    "conflict": 4,
    "write-failed": 5,
}


def emit_error(code: str, message: str) -> int:
    """致命错误的统一输出；与警告严格分离（警告只在成功结果里）。"""
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False, indent=2))
    return EXIT_CODES.get(code, 1)


def document_info(parsed: ParseResult, suggested: dict) -> dict:
    """inspect/plan共用的文档概览：建议信息 + 统计。"""
    return {
        "suggestedTitle": suggested.get("title", "") or parsed.word_title,
        "suggestedSlug": suggested.get("slug", ""),
        "suggestedSection": suggested.get("section", ""),
        "suggestedCollection": suggested.get("collection", ""),
        "suggestedCollectionSlug": suggested.get("collection_slug", ""),
        "wordTitle": parsed.word_title,
        "wordCount": parsed.word_count,
        "paragraphCount": parsed.paragraph_count,
        "headingCount": parsed.heading_count,
        "imageCount": len(parsed.images),
        "footnoteCount": parsed.footnote_count,
    }


def inspect_docx(source, project_root) -> dict:
    """解析 + 文件名建议；不写盘。作者台可直接import使用。"""
    parsed = parse_docx(source)
    suggested = suggest(parsed.source.filename, Path(project_root))
    return {
        "source": {
            "filename": parsed.source.filename,
            "size": parsed.source.size,
            "sha256": parsed.source.sha256,
        },
        "document": document_info(parsed, suggested),
        "warnings": [
            {"code": item.code, "message": item.message, "location": item.location} for item in parsed.warnings
        ],
    }


def options_from_args(args: argparse.Namespace, parsed: ParseResult, suggested: dict) -> ImportOptions:
    """命令行选项优先；缺省时退回docx-assistant按文件名的建议。"""
    title = (args.title or "").strip() or suggested.get("title", "") or parsed.word_title
    slug = (args.slug or "").strip() or suggested.get("slug", "")
    section = args.section or suggested.get("section", "") or "essays"
    collections = split_values(args.collection)
    if not collections and suggested.get("collection"):
        collections = [suggested["collection"]]
    collection_slug = (args.collection_slug or "").strip() or suggested.get("collection_slug", "")
    if section == "works" and not collection_slug and collections:
        collection_slug = assistant_slugify(collections[0])
    return ImportOptions(
        title=title,
        subtitle=args.subtitle,
        slug=slug,
        section=section,
        collections=collections,
        collection_slug=collection_slug,
        categories=split_values(args.category),
        tags=split_values(args.tag),
        series=split_values(args.series),
        period=split_values(args.period),
        people=split_values(args.people),
        places=split_values(args.places),
        description=args.description,
        date=args.date,
        weight=args.weight,
        draft=bool(args.draft),
        article_id=args.article_id or "",
    )


def plan_docx(source, options: ImportOptions, project_root) -> ImportPlan:
    """parse + plan；不写盘。作者台可直接import使用。"""
    parsed = parse_docx(source)
    return plan_import(parsed, options, project_root)


def commit_plan(plan, source, project_root, force: bool = False, backup_dir=None):
    """校验sha256与冲突后执行写入。作者台可直接import使用。"""
    return commit_import(plan, source, project_root, force=force, backup_dir=backup_dir)


def cmd_inspect(args: argparse.Namespace) -> int:
    result = inspect_docx(args.input, args.project_root)
    if args.json:
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    else:
        document = result["document"]
        print(f"文件：{result['source']['filename']}（约{document['wordCount']}字，{document['imageCount']}张图片）")
        print(f"建议：{document['suggestedSection']} / {document['suggestedTitle']} / {document['suggestedSlug']}")
        if result["warnings"]:
            print(f"需要检查（{len(result['warnings'])}项）：")
            for index, warning in enumerate(result["warnings"], 1):
                print(f"  {index}. {warning['message']}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    parsed = parse_docx(args.input)
    suggested = suggest(parsed.source.filename, args.project_root)
    options = options_from_args(args, parsed, suggested)
    plan = plan_import(parsed, options, args.project_root)
    plan_dict = plan.to_json_dict()
    if args.save:
        save_path = Path(args.save)
        save_path.write_text(json.dumps(plan_dict, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps({"ok": True, "plan": plan_dict}, ensure_ascii=False, indent=2))
    else:
        print(f"目标：{plan.target}")
        print(f"标题：{plan.front_matter.get('title', '')}（slug={plan.front_matter.get('slug', '')}）")
        print(f"计划写入{len(plan.proposed_files)}个文件。")
        if plan.conflicts:
            print(f"冲突（{len(plan.conflicts)}项）：")
            for conflict in plan.conflicts:
                print(f"  - [{conflict.code}] {conflict.message}")
        if plan.warnings:
            print(f"需要检查（{len(plan.warnings)}项）：")
            for index, warning in enumerate(plan.warnings, 1):
                print(f"  {index}. {warning.message}")
    return 0


def cmd_commit(args: argparse.Namespace) -> int:
    try:
        plan_data = json.loads(Path(args.plan).read_text(encoding="utf-8"))
        if isinstance(plan_data, dict) and "plan" in plan_data:
            plan_data = plan_data["plan"]
        plan = ImportPlan.from_json_dict(plan_data)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return emit_error("validation-failed", f"无法读取导入计划：{error}")
    source = Path(args.source)
    if not source.is_file():
        return emit_error("invalid-source", f"找不到Word文件：{source}")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != plan.source.sha256:
        return emit_error("validation-failed", "源文件与计划不一致（sha256不匹配）。")
    if plan.conflicts:
        return emit_error("conflict", "；".join(conflict.message for conflict in plan.conflicts))
    if not args.yes:
        if not sys.stdin.isatty():
            return emit_error("confirmation-required", "非交互环境请显式加--yes确认写入。")
        print(f"将写入{len(plan.proposed_files)}个文件到{plan.target}。")
        answer = input("确认导入？[y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            return emit_error("confirmation-required", "已取消。")
    try:
        result = commit_plan(plan, source, args.project_root, backup_dir=args.backup_dir)
    except ImportFailure as error:
        return emit_error(error.code, str(error))
    except OSError as error:
        return emit_error("write-failed", str(error))
    payload = {
        "output": result.output,
        "markdown": result.markdown,
        "title": result.title,
        "slug": result.slug,
        "section": result.section,
        "wordCount": result.word_count,
        "imageCount": result.image_count,
        "backup": result.backup,
        "warnings": [
            {"code": item.code, "message": item.message, "location": item.location} for item in result.warnings
        ],
    }
    if args.json:
        print(json.dumps({"ok": True, "result": payload}, ensure_ascii=False, indent=2))
    else:
        print(f"导入成功：{result.title}")
        print(f"生成目录：{result.output}")
        print(f"正文统计：约{result.word_count}字，{result.image_count}张图片")
        if result.warnings:
            print(f"需要检查（{len(result.warnings)}项）：")
            for index, warning in enumerate(result.warnings, 1):
                print(f"  {index}. {warning.message}")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="DOCX导入的机器接口（inspect/plan/commit）。")
    result.add_argument("--project-root", type=Path, default=_HERE.parent)
    subparsers = result.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="解析并给出文件名建议")
    inspect_parser.add_argument("input", type=Path)
    inspect_parser.add_argument("--json", action="store_true")

    plan_parser = subparsers.add_parser("plan", help="生成导入计划（JSON）")
    plan_parser.add_argument("input", type=Path)
    plan_parser.add_argument("--json", action="store_true")
    plan_parser.add_argument("--save", default="", help="把计划写入plan.json")
    plan_parser.add_argument("--title", default="")
    plan_parser.add_argument("--subtitle", default="")
    plan_parser.add_argument("--slug", default="")
    plan_parser.add_argument("--section", choices=("works", "essays", "archives"), default="")
    plan_parser.add_argument("--collection", action="append", default=[])
    plan_parser.add_argument("--collection-slug", default="")
    plan_parser.add_argument("--category", action="append", default=[])
    plan_parser.add_argument("--tag", action="append", default=[])
    plan_parser.add_argument("--series", action="append", default=[])
    plan_parser.add_argument("--period", action="append", default=[])
    plan_parser.add_argument("--people", action="append", default=[])
    plan_parser.add_argument("--places", action="append", default=[])
    plan_parser.add_argument("--description", default="")
    plan_parser.add_argument("--date", default="")
    plan_parser.add_argument("--weight", type=int, default=10)
    plan_parser.add_argument("--draft", action=argparse.BooleanOptionalAction, default=True)
    plan_parser.add_argument("--article-id", default="")

    commit_parser = subparsers.add_parser("commit", help="按导入计划执行写入")
    commit_parser.add_argument("plan", type=Path, help="plan子命令保存的plan.json")
    commit_parser.add_argument("--source", type=Path, required=True, help="生成计划时的同一份DOCX")
    commit_parser.add_argument("--yes", action="store_true", help="跳过交互确认（无tty时必须）")
    commit_parser.add_argument("--json", action="store_true")
    commit_parser.add_argument("--backup-dir", type=Path, default=None)
    return result


def main() -> int:
    args = parser().parse_args()
    handler = {"inspect": cmd_inspect, "plan": cmd_plan, "commit": cmd_commit}[args.command]
    try:
        return handler(args)
    except ImportFailure as error:
        return emit_error(error.code, str(error))
    except OSError as error:
        return emit_error("write-failed", str(error))
    except Exception as error:
        return emit_error("internal-error", f"无法处理Word文档（{type(error).__name__}）。")


if __name__ == "__main__":
    raise SystemExit(main())
