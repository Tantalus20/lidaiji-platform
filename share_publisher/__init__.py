"""长文分享 QQ 空间发布调度包：SQLite 调度、网页发布阶段、QZone 适配器。

- db.py     发布数据库（状态机、原子认领、幂等、崩溃恢复）
- web.py    网页发布阶段（分享站构建 + 输出验证）
- qzone.py  QZone 适配器（NapCat Cookie 获取、文字说说发布、日志脱敏）
- __main__  CLI：run-once / dry-run / status / cancel

默认绝不真实发布：QZONE_PUBLISH_ENABLED 缺省为 false，dry-run 只读不写。
"""

__version__ = "0.1.0"
