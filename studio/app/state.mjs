/* 共享状态模块。 */

/* 共享状态：文章列表/搜索与导入向导会话（state）、编辑页状态（editState）。 */

const state = {
  articles: [],
  viewCounts: {},
  searchQuery: "",
  searchResults: null,
  // Word 导入向导状态
  file: null,
  token: "",
  report: null,
  plan: null,
  previewHtml: "",
  assetUrls: [],
  committed: null,
};

const editState = {
  path: "",
  dirty: false,
  pendingHash: "",
};

export { state, editState };

