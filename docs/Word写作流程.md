# Word 写作与导入流程

V0.2.0 增加了一个只在 Mac 本地运行的“作者输入层”。网站本身仍是 Hugo
静态站，正式访问时没有 Python、数据库或 CMS 常驻进程。

## 第一次使用

1. 使用 Microsoft Word 正常写作并保存为 `.docx`。
2. 建议命名为 `《文集名·文章名》.docx`，放进桌面的“历代纪来稿箱”。
3. 双击桌面的“历代纪写作”，点击“导入 Word 文稿”。
4. 第一次导入会在项目内建立 `.venv-importer` 并安装固定版本依赖。
   这个目录不会进入 Git、备份或发布包。
5. 系统自动识别文集、标题和拼音 slug；作者只需选择保存为草稿或直接公开。

不需要手工编辑 Markdown，也不需要手工拆图片。

桌面上有两个入口：

- `历代纪来稿箱`：直接拖入Word；
- “历代纪写作”：打开图形化作者工具。

如需重新安装，可双击项目中的 `install-shortcuts.command`。安装器只会更新
本项目自己的应用，不会覆盖桌面上来源不明的同名文件。

## 导入结果

例如：

```text
incoming/《示例文集·春日记.docx》
```

系统无需作者填写这些技术字段，会直接生成：

```text
content/works/sample-works/spring-notes/
├── index.md
└── images/
    ├── image-001.webp
    └── original/
        └── image-001.png
```

独立随笔生成到 `content/essays/<slug>/`，资料性文章生成到
`content/archives/<slug>/`。

## 预览和修改

导入成功后会自动启动预览并打开新文章。也可在应用中点击“预览网站”。浏览器访问：

```text
http://127.0.0.1:1313/
```

选择“保存为草稿”时，预览能看到，但正式网站不会发布；选择“直接公开”时，
文章会进入下一次发布。作者无需手工修改 Markdown。

命令默认拒绝无提示覆盖，避免把已经在 Markdown 中做过的修订误删。如需更新，
再次导入同名文章时，应用会明确询问是否替换。选择“备份并替换”后，系统先把
旧 Markdown 和图片复制到 `~/Documents/历代纪文稿备份/`，成功备份后才覆盖当前稿。

## 发布

在应用中点击“发布网站”。发布前会：

1. 列出本次新增、修改和删除的文章；
2. 明确标记“将公开”或“草稿，不会公开”；
3. 检查 `content/` 与 `static/` 中没有 Word 原稿；
4. 检查没有未完成的导入临时目录；
5. 构建并检查静态发布包；
6. 通过原有原子发布流程切换 release，失败时不覆盖旧站。

`incoming/` 内的 Word 原稿不会上传到服务器发布源码包。

## 命令行用法

```bash
python3 importer/docx-importer.py incoming/example.docx \
  --section works \
  --title "春日记" \
  --slug spring-notes \
  --collection "示例文集" \
  --collection-slug sample-works \
  --category "纪事" \
  --tag "春日,测试" \
  --draft
```

脚本只接受 `.docx`，拒绝 `.docm`；不执行宏、不打开外部链接、不上传文件。

## 备份

`backup.command` 的源码备份包含 `incoming/`、`importer/`、文章 Markdown、
图片、脚本和文档。服务器发布包会排除 Word 原稿和 `.venv-importer`。

Word 是作者输入稿，Markdown Page Bundle 是最终发布稿；两者都应保留备份。
