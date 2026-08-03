#!/usr/bin/env python3
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "importer"))
from paragraph_ids import assign_ids, records_from_markdown  # noqa: E402


class ParagraphIdentityTests(unittest.TestCase):
    def test_01首次导入生成唯一ID(self):
        result, report = assign_ids("甲段。\n\n乙段。\n")
        records = records_from_markdown(result)
        self.assertEqual(len(records), 2)
        self.assertEqual(len({item.paragraph_id for item in records}), 2)
        self.assertEqual(report.created, 2)

    def test_02重新构建ID不变(self):
        first, _ = assign_ids("甲段。\n\n乙段。\n")
        second, report = assign_ids(first, first)
        self.assertEqual([x.paragraph_id for x in records_from_markdown(first)], [x.paragraph_id for x in records_from_markdown(second)])
        self.assertEqual(report.created, 0)

    def test_03标题变化不改变正文ID(self):
        first, _ = assign_ids("# 旧标题\n\n甲段。\n")
        second, _ = assign_ids("# 新标题\n\n甲段。\n", first)
        self.assertEqual(records_from_markdown(first)[0].paragraph_id, records_from_markdown(second)[0].paragraph_id)

    def test_04前文插入新段后原段ID保留(self):
        first, _ = assign_ids("甲段。\n\n乙段。\n")
        second, report = assign_ids("新增段。\n\n甲段。\n\n乙段。\n", first)
        old = {x.text: x.paragraph_id for x in records_from_markdown(first)}
        new = {x.text: x.paragraph_id for x in records_from_markdown(second)}
        self.assertEqual(old["甲段。"], new["甲段。"])
        self.assertEqual(old["乙段。"], new["乙段。"])
        self.assertEqual(report.created, 1)

    def test_05删除段落会出现在删除报告(self):
        first, _ = assign_ids("甲段。\n\n乙段。\n")
        _, report = assign_ids("甲段。\n", first)
        self.assertEqual(len(report.deleted), 1)
        self.assertEqual(report.deleted[0].text, "乙段。")

    def test_06重复文本拥有不同ID(self):
        result, _ = assign_ids("相同。\n\n相同。\n")
        ids = [x.paragraph_id for x in records_from_markdown(result)]
        self.assertEqual(len(ids), 2)
        self.assertNotEqual(ids[0], ids[1])

    def test_07重复文本插入时不会合并(self):
        first, _ = assign_ids("# 一\n\n相同。\n\n# 二\n\n相同。\n")
        second, _ = assign_ids("# 一\n\n新增。\n\n相同。\n\n# 二\n\n相同。\n", first)
        old = records_from_markdown(first)
        new = records_from_markdown(second)
        self.assertEqual(old[0].paragraph_id, new[1].paragraph_id)
        self.assertEqual(old[1].paragraph_id, new[2].paragraph_id)

    def test_08轻微修改高置信保留(self):
        first, _ = assign_ids("这是一个足够长、用于验证轻微文字修订仍保留身份的自然段。\n")
        second, report = assign_ids("这是一个足够长、用于验证轻微文本修订仍保留身份的自然段。\n", first)
        self.assertEqual(records_from_markdown(first)[0].paragraph_id, records_from_markdown(second)[0].paragraph_id)
        self.assertEqual(report.retained, 1)

    def test_09低置信修改不盲目迁移(self):
        first, _ = assign_ids("原文的意义完全不同。\n")
        second, report = assign_ids("一段毫无关系的新内容。\n", first)
        self.assertNotEqual(records_from_markdown(first)[0].paragraph_id, records_from_markdown(second)[0].paragraph_id)
        self.assertEqual(report.created, 1)

    def test_10标题与列表不生成段落ID(self):
        result, _ = assign_ids("# 标题\n\n- 条目\n\n2. 有序条目\n\n[^note]: 脚注。\n\n普通段。\n")
        self.assertEqual(len(records_from_markdown(result)), 1)

    def test_11诗歌尾注容器内段落不生成段落ID(self):
        body = (
            "普通段。\n\n"
            "{{< poetry >}}\n\n山有木兮木有枝\n\n心悦君兮君不知\n\n{{< /poetry >}}\n\n"
            "{{< endnote >}}\n\n写于二〇二六年八月\n\n{{< /endnote >}}\n\n"
            "{{< align center >}}\n\n居中题记\n\n{{< /align >}}\n"
        )
        # 无锚点注释时 records 为空（含普通段）；关键看 assign_ids 只给普通段建锚点
        self.assertEqual(len(records_from_markdown(body)), 0)
        result, report = assign_ids(body, body)
        self.assertEqual(report.created, 1, "只给普通段创建锚点")
        self.assertEqual(len(records_from_markdown(result)), 1, "只有普通段参与段评身份")
        self.assertNotIn("paragraph-id:", result.split("{{< poetry >}}")[1].split("{{< /poetry >}}")[0])
        self.assertNotIn("paragraph-id:", result.split("{{< endnote >}}")[1].split("{{< /endnote >}}")[0])
        self.assertNotIn("paragraph-id:", result.split("{{< align center >}}")[1].split("{{< /align >}}")[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
