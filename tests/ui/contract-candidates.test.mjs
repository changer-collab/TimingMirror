#!/usr/bin/env node
/**
 * 规则工作区候选回归（静态结构；不联网）
 *
 * 覆盖：候选框位于当前生效规则上方；只来自已发布账单的行为发现；
 *       忽略/恢复写入画像状态并重绘；无可用账单时隐藏；
 *       样式随 shadow DOM 生效，候选入口接线。
 * 运行：node tests/ui/contract-candidates.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const contractView = read('src/ui/views/contractView.js');
const realBridge = read('prototype/user-frontend/realBridge.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const block = (source, start, endMarker) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + start.length);
  return source.slice(from, to < 0 ? source.length : to);
};

const candidates = block(contractView, '/* —— 规则候选', 'function currentCard(rule)');
const paint = block(contractView, 'async function paintCandidates()', '\n\n  function currentCard');

/* ==== 位置与数据来源 ==== */
check('候选：构建器来自画像模块，不使用本地伪造证据',
  /import \{ buildRuleCandidates \} from '\.\.\/\.\.\/engine\/userProfile\.js';/.test(contractView)
  && /buildRuleCandidates\(\{/.test(candidates)
  && /ctx\.qaDeps\?\.getReportBundle\?\.\(bill\)/.test(candidates)
  && /loadReportBundle\(bill\)/.test(candidates), candidates.slice(0, 320));

check('候选：位于“当前生效规则”之前，标题说明来源与确认口径',
  /page\.append\(candidateBox, currentBox\);/.test(contractView)
  && contractView.indexOf('page.append(candidateBox, currentBox)') < contractView.indexOf('page.append(el(\'details\', { class: \'card cv-history\'')
  && candidates.includes("CANDIDATE_TITLE = '规则候选（来自本账单证据）'")
  && candidates.includes('候选只做模板预填；保存前由你确认或改写，系统不会自动启用。'),
  contractView.slice(0, 360));

check('候选：只读取已发布账单的行为发现',
  /bundle\?\.review\?\.portfolio_published === true/.test(paint)
  && /bundle\?\.insights\?\.behavior\?\.available/.test(paint)
  && /当前账单组合结果未发布：暂不生成规则候选。/.test(paint)
  && /本账单的行为发现暂不可用：暂不生成规则候选。/.test(paint), paint.slice(0, 420));

check('候选：无已确认本地账单或示例账单时隐藏',
  /const usable = bill && bill\.status === 'confirmed' && bill\.sourceType === 'local' && bill\.demo !== true;/.test(paint)
  && /if \(!usable\) \{\s*candidateBox\.hidden = true;\s*return;\s*\}/.test(paint)
  && /candidateBox\.hidden = false;/.test(paint), paint.slice(0, 300));

check('候选：加载完成或切换账单后不覆盖新状态',
  /const token = \+\+candidateToken;/.test(paint)
  && /if \(token !== candidateToken \|\| !candidateBox\.isConnected\) return;/.test(paint)
  && /if \(state\.bill\?\.contextId !== bill\.contextId\) return;/.test(paint), paint.slice(0, 360));

/* ==== 状态与动作 ==== */
check('候选：忽略/恢复写入画像事件并重绘',
  /ctx\.qaDeps\?\.recordCandidateEvent\?\.\(candidate\.candidate_id, status\)/.test(candidates)
  && /void paintCandidates\(\);/.test(candidates)
  && /markCandidate\(candidate, 'dismissed'\)/.test(candidates)
  && /markCandidate\(candidate, 'restored'\)/.test(candidates), candidates.slice(0, 420));

check('候选：打开模板复用现有确认流程',
  /typeof ctx\.qaDeps\?\.openRuleCandidate === 'function'/.test(candidates)
  && /ctx\.qaDeps\.openRuleCandidate\(ctx, candidate\)/.test(candidates)
  && /candidate-open/.test(candidates), candidates.slice(0, 300));

check('候选：按状态提供按钮，active 无需操作',
  /candidate\.status === 'available'/.test(candidates)
  && /candidate\.status === 'dismissed'/.test(candidates)
  && /打开模板确认/.test(candidates)
  && /忽略这条候选/.test(candidates)
  && /恢复候选/.test(candidates)
  && !/candidate\.status === 'active'[\s\S]{0,80}markCandidate/.test(candidates), candidates.slice(0, 520));

check('候选：空态与未达标折叠使用用户语言',
  /当前没有可建立的规则候选。/.test(candidates)
  && /本次没有读取到规则候选：/.test(candidates)
  && /条行为模式尚未达到可建规则的条件/.test(candidates)
  && /not_recommended/.test(candidates)
  && /cv-candidate-more/.test(candidates), candidates.slice(0, 520));

check('候选：证据最多 6 条，并展示理由、依据与限制',
  /candidate\.evidence\.slice\(0, 6\)/.test(candidates)
  && /candidate\.reason/.test(candidates)
  && /candidate\.basis/.test(candidates)
  && /candidate\.caveat/.test(candidates)
  && /cv-candidate-evidence/.test(candidates), candidates.slice(0, 520));

/* ==== 接线与样式 ==== */
check('候选：qaDeps 暴露状态记录与模板打开',
  /recordCandidateEvent: \(id, status\) => recordCandidateEvent\(id, status\)/.test(realBridge)
  && /openRuleCandidate,/.test(realBridge), realBridge.slice(0, 200));

check('候选：shadow DOM 内具备候选样式',
  /\.cv-candidates \{/.test(realBridge)
  && /\.cv-candidate\[data-status="available"\]/.test(realBridge)
  && /\.cv-candidate\[data-status="dismissed"\]/.test(realBridge)
  && /\.cv-candidate-evidence/.test(realBridge)
  && /\.cv-candidate-actions/.test(realBridge), realBridge.slice(0, 200));

check('候选：挂载后主动拉取一次，不阻塞规则区渲染',
  /root\.append\(page\);\s*void paintCandidates\(\);/.test(contractView), contractView.slice(-320));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
