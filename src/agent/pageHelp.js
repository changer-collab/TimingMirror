// 页面帮助问题：只用于把操作、隐私、可见状态问题留在助手，不进入账单意图或在线意图。
const PAGE_HELP_RE = /(原始\s*CSV|CSV.*上传|上传.*CSV|支持.*(格式|文件)|文件.*格式|怎么导入|如何导入|导入.*(步骤|失败|报错|修正)|数据.*安全|隐私|会上传吗|清空对话|记入画像|画像依据|画像.*记录|助手.*(怎么|什么|帮助)|证据.*(哪里看|在哪看|怎么查看|如何查看)|(回答|页面|报告).{0,8}证据|(页面|界面|助手|帮助).{0,10}(怎么|如何|什么|在哪|哪里|说明|操作|使用|上传|隐私|证据|状态|错误|报错|提示)|(怎么|如何|什么).{0,6}(页面|界面|助手|帮助|导航|按钮|入口)|登录|账号|云端|导出|水印)/u;

export function isPageHelpQuestion(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return !!value && PAGE_HELP_RE.test(value);
}

/* 页面帮助问题的固定信封：只引导到助手帮助，不读取账单、不发送模型。 */
export function buildPageHelpAnswer() {
  return {
    status: 'local',
    intent: null,
    route: { layer: 'L3', confidence: null },
    source: 'template',
    text: '这是页面操作或隐私问题。请在「AI 助手」的帮助说明中查看；问答页不会把这类问题发送到在线服务。',
    facts: [],
    evidence: [],
    actions: [{ id: 'assistant-help', label: '查看助手帮助', kind: 'assistant-help' }],
    trace: { template_id: null, plan_id: null, fact_count: 0, number_check: null, elapsed_ms: 0, intent_code: 'page_help', layer_label: '页面帮助' },
    candidate: null,
    notice: null,
    diagnostics: [],
    bill_context_id: null,
  };
}
