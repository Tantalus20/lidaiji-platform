/* 保存状态机（纯逻辑，零 DOM 依赖，可被 Node 测试直接 import）。
 *
 * 状态：
 *   saved  —— 服务端已确认保存成功（或刚打开文章）
 *   dirty  —— 有未保存修改
 *   saving —— 保存请求进行中
 *   failed —— 保存请求失败（仍是未保存状态）
 *
 * 规则：
 *   - 用户输入 → dirty；若正处于 saving，则记录"保存期间有输入"，
 *     下次 saved() 时自动回到 dirty（而不是伪造"已保存"）；
 *   - 发起保存 → saving；服务端确认成功 → saved；
 *   - 失败 → failed；之后再输入 → dirty；
 *   - "磁盘内容已变化"（外部修改文件）为预留状态，本轮不实现检测，
 *     也不允许前端仅因发出请求就声称"已保存"。
 */
export function createSaveStateMachine() {
  let status = "saved";
  let dirtyDuringSave = false;
  const listeners = [];

  function emit(next) {
    for (const listener of listeners) listener(next);
  }

  return {
    get status() {
      return status;
    },

    onChange(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },

    /* 用户输入（或任何未保存修改）。返回变更后的状态。 */
    userInput() {
      if (status === "saving") {
        dirtyDuringSave = true;
        return status;
      }
      status = "dirty";
      emit(status);
      return status;
    },

    /* 发起保存请求。重复调用（并发防护）不改变状态、不重复通知。 */
    saving() {
      if (status === "saving") return status;
      dirtyDuringSave = false;
      status = "saving";
      emit(status);
      return status;
    },

    /* 服务端确认成功。若保存期间又有输入则回到 dirty。 */
    saved() {
      const next = dirtyDuringSave ? "dirty" : "saved";
      dirtyDuringSave = false;
      status = next;
      emit(status);
      return status;
    },

    /* 保存失败（仍是未保存状态）。 */
    failed() {
      status = "failed";
      emit(status);
      return status;
    },

    /* 重新打开文章：回到初始"已保存"。 */
    reset() {
      dirtyDuringSave = false;
      status = "saved";
      emit(status);
      return status;
    },
  };
}
