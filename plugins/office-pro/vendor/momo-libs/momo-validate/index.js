// office 产物结构校验（spec 2026-11-03 §5.2）：zip 完整性 + 关键部件存在性 +
// XML 良构粗检 + 关键部件顶层元素序/必需元素校验 + rels 链 + 索引越界 + pdf
// 头尾轻检（2026-11-04 交付门禁升级）。定位是「agent 收工自查」——覆盖 MS
// Office 严格解析的修复删内容诱因，非全量 XSD 等价。
'use strict';
const AdmZip = require('adm-zip');
const fs = require('node:fs');

// ── 元素序校验（CT_Worksheet / CT_ChartSpace / CT_Chart / CT_PlotArea）──────
// 实锤（2026-11-04 销售利润跟踪表.xlsx）：sheet 顶层 extLst 后跟 drawing 违反
// CT_Worksheet 序，MS Excel 打开报「修复或删除不可读取的内容」并丢弃整个 sheet；
// exceljs/预览等宽松解析器不报——唯有校验器拦在交付前。

const WORKSHEET_SEQ = [
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter',
  'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr',
  'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions',
  'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing',
  'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects',
  'controls', 'webPublishItems', 'tableParts', 'extLst',
];

const CHARTSPACE_SEQ = [
  'c:date1904', 'c:lang', 'c:roundedCorners', 'c:style', 'c:clrMapOvr',
  'c:pivotSource', 'c:protection', 'c:chart', 'c:spPr', 'c:txPr',
  'c:externalData', 'c:printSettings', 'c:userShapes', 'c:extLst',
];

const CHART_SEQ = [
  'c:title', 'c:autoTitleDeleted', 'c:pivotFmts', 'c:view3D', 'c:floor',
  'c:sideWall', 'c:backWall', 'c:plotArea', 'c:legend', 'c:plotVisOnly',
  'c:dispBlanksAs', 'c:showDLblsOverMax', 'c:extLst',
];

// CT_PlotArea 序组：ECMA-376 中 17 种图表类型与 4 种轴均为 maxOccurs=unbounded
// 的 choice（组内无序，组合图任意排列合法——barChart→lineChart 是常态序列，
// 独立序位会误报拦截合法产物）；大层次「图表组→轴→dTable→spPr→extLst」仍严格。
const CHART_GROUP_TYPES = [
  'c:areaChart', 'c:area3DChart', 'c:lineChart', 'c:line3DChart', 'c:stockChart',
  'c:radarChart', 'c:scatterChart', 'c:pieChart', 'c:pie3DChart',
  'c:doughnutChart', 'c:barChart', 'c:bar3DChart', 'c:bubbleChart',
  'c:ofPieChart', 'c:surfaceChart', 'c:surface3DChart',
];
const AXES_TYPES = ['c:catAx', 'c:dateAx', 'c:serAx', 'c:valAx'];

/** 序组 → 元素→秩映射（组内同秩） */
function buildRank(groups) {
  const m = new Map();
  groups.forEach((g, i) => g.forEach((n) => m.set(n, i)));
  return m;
}
const WORKSHEET_RANK = buildRank(WORKSHEET_SEQ.map((n) => [n]));
const CHARTSPACE_RANK = buildRank(CHARTSPACE_SEQ.map((n) => [n]));
const CHART_RANK = buildRank(CHART_SEQ.map((n) => [n]));
const PLOTAREA_RANK = buildRank([
  ['c:layout'], CHART_GROUP_TYPES, AXES_TYPES, ['c:dTable'], ['c:spPr'], ['c:extLst'],
]);
const CHART_GROUP_SET = new Set(CHART_GROUP_TYPES);
const WORKSHEET_REQUIRED = ['sheetData'];

/**
 * 扫描根标签的直接子元素名（按出现序；跳过注释/CDATA/PI/DOCTYPE）。
 * 手写深度扫描不引完整 parser——属性值中的 > 用引号感知跳跃规避。
 */
function topLevelChildren(xml) {
  const names = [];
  let depth = 0;
  let i = xml.indexOf('<');
  while (i !== -1) {
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i);
      i = xml.indexOf('<', end === -1 ? xml.length : end + 2);
      continue;
    }
    if (xml.startsWith('!', i + 1)) {
      const end = xml.indexOf(xml.startsWith('<!--', i) ? '-->' : '>', i);
      i = xml.indexOf('<', end === -1 ? xml.length : end);
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i);
      i = xml.indexOf('<', end === -1 ? xml.length : end + 3);
      continue;
    }
    if (xml[i + 1] === '/') {
      depth -= 1;
      const end = xml.indexOf('>', i);
      if (depth === 0) break;
      i = xml.indexOf('<', end === -1 ? xml.length : end + 1);
      continue;
    }
    let j = i + 1;
    let quote = null;
    while (j < xml.length) {
      const ch = xml[j];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j += 1;
    }
    const tagText = xml.slice(i, j);
    const name = /^<([A-Za-z_][\w.:-]*)/.exec(tagText);
    if (name !== null) {
      depth += 1;
      if (depth === 2) names.push(name[1]);
      if (tagText.endsWith('/')) depth -= 1;
    }
    i = xml.indexOf('<', j);
  }
  return names;
}

/** 已知元素的非递减序检查（秩映射，组内同秩）：违例返回首个，合法返回 null */
function orderViolation(names, rank) {
  let maxRank = -1;
  let lastName = null;
  for (const n of names) {
    const r = rank.get(n);
    if (r === undefined) continue; // canonical 外元素不判位（防误报）
    if (r < maxRank) return { elem: n, after: lastName };
    maxRank = r;
    lastName = n;
  }
  return null;
}

function checkOrder(names, rank, part, label, errors) {
  const v = orderViolation(names, rank);
  if (v !== null) {
    errors.push(
      `部件 ${part} 元素序违规：${v.elem} 须在 ${v.after} 之前（${label} 元素序）` +
        '——MS Office 严格解析会判损坏并触发「修复删除内容」',
    );
  }
}

/** 单个非嵌套子树提取（c:chart / c:plotArea 各至多一颗且不自嵌） */
function extractSubtree(xml, openRe, closeTag) {
  const m = openRe.exec(xml);
  if (m === null) return null;
  const closeIdx = xml.indexOf(closeTag, m.index);
  if (closeIdx === -1) return null;
  return xml.slice(m.index, closeIdx + closeTag.length);
}

/** 必需元素在场检查（序校验只看在场元素——缺失类静默损坏曾全过门禁） */
function checkRequired(names, required, part, label, errors) {
  for (const req of required) {
    if (!names.includes(req)) {
      errors.push(`部件 ${part} 缺少必需元素 ${req}（${label}）——MS Office 严格解析会判损坏`);
    }
  }
}

/** 部件路由：worksheet → CT_Worksheet；chart → 三层（Space/chart/plotArea） */
function checkPartOrder(part, xml, errors) {
  if (/^xl\/worksheets\/sheet\d+\.xml$/.test(part)) {
    const names = topLevelChildren(xml);
    checkOrder(names, WORKSHEET_RANK, part, 'CT_Worksheet', errors);
    checkRequired(names, WORKSHEET_REQUIRED, part, 'CT_Worksheet', errors);
    return;
  }
  if (/^xl\/charts\/chart\d+\.xml$/.test(part)) {
    const spaceNames = topLevelChildren(xml);
    checkOrder(spaceNames, CHARTSPACE_RANK, part, 'CT_ChartSpace', errors);
    checkRequired(spaceNames, ['c:chart'], part, 'CT_ChartSpace', errors);
    const chart = extractSubtree(xml, /<c:chart(?:\s|>)/, '</c:chart>');
    if (chart !== null) {
      const chartNames = topLevelChildren(chart);
      checkOrder(chartNames, CHART_RANK, part, 'CT_Chart', errors);
      checkRequired(chartNames, ['c:plotArea'], part, 'CT_Chart', errors);
    }
    const plotArea = extractSubtree(xml, /<c:plotArea(?:\s|>)/, '</c:plotArea>');
    if (plotArea !== null) {
      const paNames = topLevelChildren(plotArea);
      checkOrder(paNames, PLOTAREA_RANK, part, 'CT_PlotArea', errors);
      if (!paNames.some((n) => CHART_GROUP_SET.has(n))) {
        errors.push(`部件 ${part} 缺少必需元素：plotArea 无图表体（c:barChart/c:lineChart 等至少其一）`);
      }
    }
  }
}

// ── rels 链一致性 + 索引越界（交付门禁补强 2026-11-04）───────────────────────
// 与元素序同属「Office 修复触发器」家族：rels 指向不存在部件 / ContentTypes
// Override 悬空 / 样式与共享字符串索引越界，均触发「修复删除内容」。

/** rels 部件路径 → 目标部件包内路径解析（'X/_rels/Y.rels' 基准 X/；'../' 归一） */
function resolveRelsTarget(relsPart, target) {
  const marker = relsPart.lastIndexOf('/_rels/');
  const base = marker === -1 ? '' : relsPart.slice(0, marker + 1);
  const out = [];
  for (const seg of (base + target).split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** 全部 *.rels 的 Target 指向必须存在（TargetMode="External" 外链豁免）；每类上限 5 条防刷屏 */
function checkRelsGraph(texts, names, errors) {
  let reported = 0;
  for (const [part, text] of texts) {
    if (!part.endsWith('.rels')) continue;
    for (const m of text.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue;
      const t = /Target="([^"]*)"/.exec(m[0]);
      if (t === null) continue;
      const resolved = resolveRelsTarget(part, t[1]);
      if (!names.has(resolved)) {
        errors.push(`rels 断链: ${part} → Target "${t[1]}"（解析为 ${resolved}）在包内不存在`);
        reported += 1;
        if (reported >= 5) {
          errors.push('rels 断链仅示前 5 处');
          return;
        }
      }
    }
  }
}

/**
 * 包内每个部件必须有 ContentType（Override 直配或 Default 按扩展名）——
 * 「有部件无类型」才是 Office 修复触发器（无法判定读取方式）。反方向（悬空
 * Override：pptxgenjs 预声明未写入的 slideMaster2 等）实测 PowerPoint 容忍，
 * 不判（2026-11-04 generation-smoke 真产物实证）。
 */
function checkPartContentTypes(names, ctText, errors) {
  const overrides = new Set();
  for (const m of ctText.matchAll(/PartName="([^"]*)"/g)) {
    overrides.add(m[1].replace(/^\//, ''));
  }
  const defaults = new Set();
  for (const m of ctText.matchAll(/<Default\b[^>]*\bExtension="([^"]*)"/g)) {
    defaults.add(m[1].toLowerCase());
  }
  let reported = 0;
  for (const part of names) {
    if (part.endsWith('/') || part === '[Content_Types].xml') continue;
    const dot = part.lastIndexOf('.');
    const ext = dot === -1 ? '' : part.slice(dot + 1).toLowerCase();
    if (overrides.has(part) || defaults.has(ext)) continue;
    errors.push(`部件 ${part} 无 ContentType（Override/Default 均未覆盖）——Office 修复触发器`);
    reported += 1;
    if (reported >= 5) {
      errors.push('无 ContentType 部件仅示前 5 处');
      return;
    }
  }
}

/** 单元格 s= ≤ cellXfs 项数、t="s" 索引 < si 项数（部件缺失按 0 计——引用即越界） */
function checkIndexBounds(texts, errors) {
  const styles = texts.get('xl/styles.xml');
  const cellXfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles ?? '');
  const xfCount = cellXfs === null ? 0 : (cellXfs[0].match(/<xf(?:\s|>|\/>)/g) ?? []).length;
  const siCount = (texts.get('xl/sharedStrings.xml') ?? '').match(/<si(?:\s|>|\/>)/g)?.length ?? 0;

  for (const [part, text] of texts) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(part)) continue;
    let styleReported = 0;
    for (const m of text.matchAll(/<c\b[^>]*\bs="(\d+)"/g)) {
      if (Number(m[1]) >= xfCount) {
        errors.push(`样式索引越界: ${part} 单元格 s=${m[1]} ≥ cellXfs 数 ${xfCount}`);
        styleReported += 1;
        if (styleReported >= 3) break;
      }
    }
    let sharedReported = 0;
    for (const m of text.matchAll(/<c\b[^>]*\bt="s"[^>]*>\s*<v>(\d+)<\/v>/g)) {
      if (Number(m[1]) >= siCount) {
        errors.push(`共享字符串索引越界: ${part} 索引 ${m[1]} ≥ si 数 ${siCount}`);
        sharedReported += 1;
        if (sharedReported >= 3) break;
      }
    }
  }
}

/** 字符间距异常阈值（OOXML spc 单位 1/100 pt）：>12pt 视为疑似误用
 *  charSpacing（验收实锤：charSpacing: 150/180 → spc=15000/18000，PowerPoint
 *  渲染成逐字竖排并压住其他元素；结构完全合法，只有数值红线能拦） */
const SPC_LIMIT = 1200;

/** 各格式的必需部件（zip entry 名） */
const REQUIRED_PARTS = {
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml', '_rels/.rels'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels'],
  docx: ['[Content_Types].xml', 'word/document.xml', '_rels/.rels'],
};

/** XML 良构粗检：去声明/注释/CDATA 后做根级闭合配对（不引入完整 parser） */
function xmlRoughCheck(xml, part) {
  const errors = [];
  const body = xml.replace(/^\uFEFF/, '').trim();
  if (!body.startsWith('<')) return [`部件 ${part} 不以 < 开头（疑似二进制损坏）`];
  // trim 必需：真实产物（pptxgenjs/exceljs）声明与根标签之间有 \r\n，剥声明后
  // 前导空白会让下方 ^ 锚定的 open/自闭合分支失配（Task 4 接真实 pptxgenjs 产物时实证）
  const stripped = body
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .trim();
  if (/^<([A-Za-z_][\w.:-]*)[\s\S]*?\/>/.test(stripped)) return errors; // 自闭合根：合法
  const open = /^<([A-Za-z_][\w.:-]*)/.exec(stripped);
  const close = /<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(stripped);
  if (!open || !close || open[1] !== close[1]) {
    errors.push(`部件 ${part} 根标签未闭合（${open ? open[1] : '?'} vs ${close ? close[1] : '?'}）`);
  }
  return errors;
}

/**
 * 校验 office 产物。
 * @param {string} abs 产物绝对路径（支持 pptx / xlsx / docx）
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateOfficeFile(abs) {
  const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') {
    // pdf 非 zip 容器：头尾轻检（头判真伪、尾判截断）——四格式章程的门禁补全
    const buf = fs.readFileSync(abs);
    const errors = [];
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      errors.push('pdf 头 %PDF- 缺失（非 PDF 文件）');
    }
    if (!buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF')) {
      errors.push('pdf 尾标记 %%EOF 缺失（文件可能被截断）');
    }
    return { ok: errors.length === 0, errors };
  }
  const required = REQUIRED_PARTS[ext];
  if (!required) return { ok: false, errors: [`不支持的扩展名: .${ext}（支持 pptx/xlsx/docx/pdf）`] };
  let zip;
  try {
    zip = new AdmZip(abs);
  } catch (err) {
    return { ok: false, errors: [`zip 无法打开（文件损坏）: ${err.message}`] };
  }
  const names = new Set(zip.getEntries().map((e) => e.entryName));
  const errors = [];
  for (const part of required) {
    if (!names.has(part)) errors.push(`缺少必需部件: ${part}`);
  }
  const texts = new Map();
  for (const entry of zip.getEntries()) {
    if (!/\.(xml|rels)$/.test(entry.entryName)) continue;
    const text = entry.getData().toString('utf-8');
    texts.set(entry.entryName, text);
    if (text.includes('\u0000')) errors.push(`部件 ${entry.entryName} 含 NUL 字节（疑似损坏）`);
    for (const m of text.matchAll(/spc="(-?\d+)"/g)) {
      const v = Number(m[1]);
      if (Math.abs(v) > SPC_LIMIT) {
        errors.push(
          `部件 ${entry.entryName} 字符间距异常（spc=${v}，约 ${(Math.abs(v) / 100).toFixed(1)}pt）：` +
            '检查 charSpacing 是否为 point 值（正常 0–2）',
        );
      }
    }
    errors.push(...xmlRoughCheck(text, entry.entryName));
    checkPartOrder(entry.entryName, text, errors);
  }
  const ctText = texts.get('[Content_Types].xml');
  if (ctText !== undefined) checkPartContentTypes(names, ctText, errors);
  checkRelsGraph(texts, names, errors);
  checkIndexBounds(texts, errors);
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOfficeFile };
