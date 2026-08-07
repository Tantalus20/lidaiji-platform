# Third-Party Notices

本仓库遵守各第三方项目的许可证要求，以下列出被参考或复用其实现信息的项目。

## Wyccotccy/astrbot_plugin_qzone_tools (QzoneTools)

- 项目：https://github.com/Wyccotccy/astrbot_plugin_qzone_tools
- 许可证：MIT License
- 使用方式：仅作**协议行为参考**（不复制 AstrBot 框架代码），并复现其描述的
  NapCat + QZone 纯文字说说发布协议细节：
  - NapCat `get_login_info` 取 uin；`get_credentials`（回退
    `get_cookies`，domain=qzone.qq.com）每次发布动态取得最新 QZone Cookie；
  - g_tk 由 Cookie 中 p_skey/skey 按固定 hash 算法计算；
  - 发布走 `user.qzone.qq.com` 的 `emotion_cgi_publish_v6` 表单接口，
    以响应中 `"code":0` 判断接口是否接受（仅代表“已提交”，不代表已公开）；
  - 超时 30 秒；Cookie 失效/未登录/风控等错误分别映射为明确错误码。
- 复用范围：`share_publisher/qzone.py` 的协议常量、请求字段与错误映射
  （均为协议事实，非原创实现）。
- 许可证文本：见 https://github.com/Wyccotccy/astrbot_plugin_qzone_tools
  （MIT License 允许带此说明地使用与修改）。
- 注意：本项目不安装 AstrBot，也不复制其任何框架代码。

## Zhalslar/astrbot_plugin_qzone

- 项目：https://github.com/Zhalslar/astrbot_plugin_qzone
- 许可证：GPL-3.0（仓库 LICENSE 文件）
- 使用方式：**仅作协议行为参考**（endpoint 对照、发布结果验证思路）；
  未复制其任何代码进入本项目，因本项目主代码非 GPL 许可。
- 本项目与 GPL 代码无衍生关系；本项目代码不因此受 GPL 约束。
