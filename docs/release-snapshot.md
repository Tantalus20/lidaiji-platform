# 发布快照（release snapshot）

正式发布不再直接消费可变工作树。每次发布先生成不可变 **release snapshot**，
站点、源码包、BUILD_INFO 与服务端校验共享同一个 `releaseSnapshotId`。

## 两种模式

| 模式 | 发布输入 | 用途 |
| --- | --- | --- |
| `full_site` | 已提交平台代码 + 冻结的公开内容集合 | CLI 与 Studio 全站发布 |
| `article_isolated` | 已提交平台代码 + 可信公开基线 + 单篇目标文章快照 | Studio 单篇发布（保留 v0.2.5 隔离性质） |

两种模式共用同一条链：

```text
releaseSnapshotId → 构建 → BUILD_INFO → source package → candidate manifest → 服务端校验 → 原子发布
```

## 不变量

- 平台代码必须来自已提交的 Git commit；工作树必须干净（未跟踪文件同样拒绝）。
  生成快照时用 `git archive <platformCommit>` 固定代码，之后原工作树变化不影响快照。
- 私人内容允许未提交修改，但必须先冻结进快照；快照封存后不可变，
  复用前复验全部文件（路径、大小、SHA-256）。
- 作者评 `data/author-notes/**` 永远不是公开构建输入：不进入快照内容清单、
  BUILD_INFO、源码包或服务端校验数据。
- `site-overrides` 只允许 `site.yaml` / `branding.yaml`，且必须通过敏感扫描
  （绝对私人路径、疑似凭据）。
- 相同输入 → 相同 `snapshotId`；相同 ID 对应不同内容时拒绝。
- 源码包是“平台源码及发布来源证明包”：它证明对应的 `platformCommit`、
  `releaseSnapshotId` 与内容清单摘要，但不包含私人文章，不能单独完整重建网站。

## 命令

```bash
# 独立构建：先冻结 full_site 快照，再从快照构建
./scripts/build.sh

# 正式发布：publish.sh 冻结快照；Studio 单篇发布通过
# LIDAIJI_RELEASE_SNAPSHOT 传入 article_isolated 快照
./scripts/publish.sh

# 手工复验快照
python3 tools/release_snapshot.py verify --snapshot .cache/releases/<snapshotId>
```

快照存储在 `.cache/releases/<snapshotId>/`（Git 忽略、权限受控）：

```text
snapshot.json           # 指纹与身份字段
content-manifest.json   # content/ 与 site-overrides/ 的逐文件 SHA-256
tree/                   # 冻结后的完整构建树（含空 data/author-notes）
```

## BUILD_INFO 身份字段

站点与源码包的 BUILD_INFO 都包含并必须一致：

```text
sourceCommit / releaseSnapshotId / releaseSnapshotFingerprint /
snapshotMode / contentManifestSha256 / configFingerprint / builderVersion
```

`server-publish.sh` 会比对发布请求、站点 BUILD_INFO、源码包 BUILD_INFO 与
段评包提交，并校验发布包 SHA-256 后才切换 release。
