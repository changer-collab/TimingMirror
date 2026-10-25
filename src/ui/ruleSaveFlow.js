// 规则保存状态：先等云端结果，成功后才把版本写入当前状态；失败保留原状态供用户重试。
// 重试复用同一份完整版本列表（服务端整表替换），不会重复创建规则版本。
export const RULE_SAVE_STATE = Object.freeze({
  IDLE: 'idle',
  SAVING: 'saving',
  SAVED: 'saved',
  FAILED: 'failed',
});

export const RULE_SAVE_FAILED_TEXT = '规则未保存：云端同步失败，本地尚未生效。可重试；重试不会重复创建版本。';

export function createRuleSaveFlow({
  getContracts, set, saveRules = null, saveLocal = null,
} = {}) {
  let seq = 0;

  async function saveVersions(versions, { extra = {}, simReset = null } = {}) {
    if (!Array.isArray(versions)) return { ok: false };
    if (getContracts?.()?.saveState?.status === RULE_SAVE_STATE.SAVING) return { ok: false, busy: true };
    const token = ++seq;
    if (typeof saveRules !== 'function') {
      set({
        contracts: {
          versions,
          simContext: null,
          sim: simReset ?? getContracts?.()?.sim ?? null,
          saveState: { status: RULE_SAVE_STATE.SAVED, message: '', versions: null, at: new Date().toISOString() },
          ...extra,
        },
      });
      if (typeof saveLocal === 'function') saveLocal();
      return { ok: true, local: true };
    }
    set({
      contracts: {
        saveState: { status: RULE_SAVE_STATE.SAVING, message: '', versions, at: null },
      },
    });
    try {
      await saveRules({ versions });
    } catch {
      if (token === seq) {
        set({
          contracts: {
            saveState: { status: RULE_SAVE_STATE.FAILED, message: RULE_SAVE_FAILED_TEXT, versions, at: null },
          },
        });
      }
      return { ok: false };
    }
    if (token !== seq) return { ok: false, stale: true };
    set({
      contracts: {
        versions,
        simContext: null,
        sim: simReset ?? getContracts?.()?.sim ?? null,
        saveState: { status: RULE_SAVE_STATE.SAVED, message: '', versions: null, at: new Date().toISOString() },
        ...extra,
      },
    });
    return { ok: true };
  }

  return { saveVersions };
}
