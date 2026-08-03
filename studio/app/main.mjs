/* 前端入口：导入全部视图模块（各自的监听器随模块加载接线），然后初始化。 */

import { initTheme } from "./theme.mjs";
import { route } from "./router.mjs";
import "./home.mjs";
import "./editor-page.mjs";
import "./import-wizard.mjs";
import "./versions.mjs";
import "./publish.mjs";
import "./media.mjs";
import "./feedback.mjs";
import "./notes.mjs";

initTheme();
route();
