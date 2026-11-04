// momo-validate 行为锁（spec 2026-11-03 §5.2）：zip 完整性 / 必需部件 / XML 良构粗检。
// 夹具用 adm-zip 手工构造（不依赖 vendor 安装——adm-zip 为本仓 devDependency）。
// 自 momo-studio officepro 随迁；vendor/momo-libs 为 git 跟踪文件，恒在位。
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './fixtures';

interface ValidateResult { ok: boolean; errors: string[] }
const { validateOfficeFile } = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-validate/index.js')) as {
  validateOfficeFile: (abs: string) => ValidateResult;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mv-'));

function zipWrite(name: string, entries: Array<[string, string]>): string {
  const zip = new AdmZip();
  for (const [entry, content] of entries) zip.addFile(entry, Buffer.from(content, 'utf-8'));
  const p = path.join(tmp, name);
  zip.writeZip(p);
  return p;
}

const XML = '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="urn:x"></p:presentation>';
const CT_D = '<?xml version="1.0"?><Types xmlns="urn:x">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

describe('momo-validate（结构校验）', () => {
  it('合法最小 pptx → ok', () => {
    const f = zipWrite('ok.pptx', [
      ['[Content_Types].xml', CT_D],
      ['_rels/.rels', XML],
      ['ppt/presentation.xml', XML],
      ['ppt/slides/slide1.xml', XML],
    ]);
    expect(validateOfficeFile(f)).toEqual({ ok: true, errors: [] });
  });

  it('缺 [Content_Types].xml → 报缺部件', () => {
    const f = zipWrite('no-ct.pptx', [['ppt/presentation.xml', XML], ['_rels/.rels', XML]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('[Content_Types].xml'))).toBe(true);
  });

  it('根标签未闭合的 xml → 良构错误', () => {
    const broken = '<?xml version="1.0"?><p:presentation xmlns:p="urn:x">';
    const f = zipWrite('broken.pptx', [
      ['[Content_Types].xml', CT_D], ['_rels/.rels', XML], ['ppt/presentation.xml', broken],
    ]);
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('随机字节（非 zip）→ 打不开报损坏', () => {
    const f = path.join(tmp, 'garbage.pptx');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('不支持的扩展名 → 明确报错', () => {
    const r = validateOfficeFile('/tmp/a.exe');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('不支持的扩展名');
  });

  // 验收实锤：charSpacing 150/180 产出 spc=15000/18000，结构合法但渲染成逐字竖排
  const slideWithSpc = (spc: string): string =>
    '<?xml version="1.0"?><p:sld xmlns:p="urn:x"><p:txBody><a:p><a:r>' +
    `<a:rPr sz="1100" spc="${spc}"/><a:t>IT 部</a:t></a:r></a:p></p:txBody></p:sld>`;

  function pptxWithSpc(name: string, spc: string): string {
    return zipWrite(name, [
      ['[Content_Types].xml', CT_D],
      ['_rels/.rels', XML],
      ['ppt/presentation.xml', XML],
      ['ppt/slides/slide1.xml', slideWithSpc(spc)],
    ]);
  }

  it('字符间距异常（spc=18000 → 180.0pt）→ 报错并给出换算', () => {
    const r = validateOfficeFile(pptxWithSpc('spc-bad.pptx', '18000'));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('字符间距异常') && e.includes('180.0pt'))).toBe(true);
  });

  it('字符间距边界：1200 不报、1300 报（阈值 >12pt）', () => {
    expect(validateOfficeFile(pptxWithSpc('spc-edge-ok.pptx', '1200')).ok).toBe(true);
    expect(validateOfficeFile(pptxWithSpc('spc-edge-bad.pptx', '1300')).ok).toBe(false);
  });

  it('正常 spc=0 不影响既有校验', () => {
    expect(validateOfficeFile(pptxWithSpc('spc-zero.pptx', '0')).ok).toBe(true);
  });
});

// 元素序校验（交付门禁升级 2026-11-04）：CT_Worksheet/CT_ChartSpace 顶层元素序
// 违规是 MS Excel「修复或删除不可读取的内容」的直接诱因（实锤：销售利润跟踪
// 表.xlsx——extLst 后跟 drawing，修复后首个页签被丢）。宽松解析器（exceljs/
// 预览）不报，唯有校验器拦在交付前。
describe('momo-validate 元素序校验（交付门禁）', () => {
  const R_XML = '<?xml version="1.0"?><Relationships xmlns="urn:x"/>';
  const CT = CT_D;
  const WB = '<?xml version="1.0"?><workbook xmlns="urn:x"><sheets/></workbook>';

  const sheetWith = (tail: string): string =>
    '<?xml version="1.0"?><worksheet xmlns="urn:x" xmlns:r="urn:r">' +
    '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
    `${tail}</worksheet>`;

  function xlsxWith(name: string, sheet: string, extra: Array<[string, string]> = []): string {
    return zipWrite(name, [
      ['[Content_Types].xml', CT],
      ['_rels/.rels', R_XML],
      ['xl/workbook.xml', WB],
      ['xl/worksheets/sheet1.xml', sheet],
      ...extra,
    ]);
  }

  it('worksheet：extLst 后出现 drawing（实锤形态）→ 序违规报错', () => {
    const bad = sheetWith('<pageMargins/><pageSetup/><extLst><ext/></extLst><drawing r:id="rId1"/>');
    const r = validateOfficeFile(xlsxWith('order-bad.xlsx', bad));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('元素序违规') && e.includes('drawing') && e.includes('extLst'))).toBe(true);
  });

  it('worksheet：drawing 在 extLst 前（schema 正确位）→ 通过', () => {
    const good = sheetWith('<pageMargins/><pageSetup/><drawing r:id="rId1"/><extLst><ext/></extLst>');
    expect(validateOfficeFile(xlsxWith('order-good.xlsx', good)).ok).toBe(true);
  });

  it('worksheet：可重复元素（conditionalFormatting 多段）+ 跳跃缺省元素不误报', () => {
    const good = sheetWith(
      '<conditionalFormatting/><conditionalFormatting/><printOptions/><pageMargins/><pageSetup/><drawing r:id="rId1"/><extLst><ext/></extLst>',
    );
    expect(validateOfficeFile(xlsxWith('order-repeat.xlsx', good)).ok).toBe(true);
  });

  const chartWith = (chartChildren: string): string =>
    '<?xml version="1.0"?><c:chartSpace xmlns:c="urn:c"><c:chart>' +
    `${chartChildren}</c:chart></c:chartSpace>`;

  it('chart：title→autoTitleDeleted→plotArea→plotVisOnly 合法序 → 通过', () => {
    const good = chartWith('<c:title/><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart/></c:plotArea><c:plotVisOnly val="1"/>');
    const f = xlsxWith('chart-good.xlsx', sheetWith('<pageSetup/>'), [
      ['xl/charts/chart1.xml', good],
    ]);
    expect(validateOfficeFile(f).ok).toBe(true);
  });

  it('chart：plotVisOnly 出现在 plotArea 之前 → 序违规报错', () => {
    const bad = chartWith('<c:title/><c:plotVisOnly val="1"/><c:plotArea><c:layout/></c:plotArea>');
    const f = xlsxWith('chart-bad.xlsx', sheetWith('<pageSetup/>'), [
      ['xl/charts/chart1.xml', bad],
    ]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('元素序违规') && e.includes('chart'))).toBe(true);
  });

  // —— P1-4 修复（深度审查目标线 FAIL 项）——
  // ECMA-376 CT_PlotArea 的 17 种图表类型与 4 种轴均为 maxOccurs=unbounded 的
  // choice（组内无序）：bar+line 组合图 barChart→lineChart 是 Excel/pptxgenjs
  // 常态序列，旧序表给独立序位会误报拦截合法产物（门禁有交付阻断权，误报 =
  // 卡死交付）。坍缩为同秩后大层次（图表组→轴→dTable→spPr）不变。
  it('plotArea：组合图 barChart→lineChart（含轴序翻转）→ 通过（choice 组内无序）', () => {
    const combo = chartWith(
      '<c:plotArea><c:layout/><c:barChart/><c:lineChart/><c:valAx/><c:catAx/></c:plotArea><c:plotVisOnly val="1"/>',
    );
    const f = xlsxWith('combo.xlsx', sheetWith('<pageSetup/>'), [['xl/charts/chart1.xml', combo]]);
    expect(validateOfficeFile(f).ok).toBe(true);
  });

  it('plotArea：图表体排在轴后（违反组层次）→ 仍报序违规', () => {
    const bad = chartWith(
      '<c:plotArea><c:layout/><c:valAx/><c:barChart/></c:plotArea>',
    );
    const f = xlsxWith('combo-bad.xlsx', sheetWith('<pageSetup/>'), [['xl/charts/chart1.xml', bad]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('元素序违规'))).toBe(true);
  });

  // 必需元素缺失检测：序校验只看在场元素，缺失（chart 无 plotArea / worksheet
  // 无 sheetData / plotArea 无任何图表体）是「静默损坏过门禁」类（质量线 MAJOR-3）
  it('必需元素：chart 缺 plotArea → 报缺失', () => {
    const bad = chartWith('<c:title/>');
    const f = xlsxWith('no-plotarea.xlsx', sheetWith('<pageSetup/>'), [['xl/charts/chart1.xml', bad]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('缺少必需元素') && e.includes('c:plotArea'))).toBe(true);
  });

  it('必需元素：worksheet 缺 sheetData → 报缺失', () => {
    const bad = '<?xml version="1.0"?><worksheet xmlns="urn:x"><pageSetup/></worksheet>';
    const r = validateOfficeFile(xlsxWith('no-sheetdata.xlsx', bad));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('缺少必需元素') && e.includes('sheetData'))).toBe(true);
  });

  it('必需元素：plotArea 无任何图表体 → 报缺失', () => {
    const bad = chartWith('<c:plotArea><c:layout/><c:catAx/><c:valAx/></c:plotArea>');
    const f = xlsxWith('no-chartbody.xlsx', sheetWith('<pageSetup/>'), [['xl/charts/chart1.xml', bad]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('缺少必需元素') && e.includes('图表'))).toBe(true);
  });

  it('未知顶层元素（canonical 外）不误报', () => {
    const good = sheetWith('<mc:AlternateContent/><pageSetup/>');
    expect(validateOfficeFile(xlsxWith('order-unknown.xlsx', good)).ok).toBe(true);
  });
});

// pdf 门禁路径（P1-6：四格式章程 vs 三格式校验器断裂——pdf 非 zip 容器，
// 旧实现经 AdmZip 打开必炸/恒 fail）
describe('momo-validate pdf 路径（交付门禁补全）', () => {
  const R_XML = '<?xml version="1.0"?><Relationships xmlns="urn:x"/>';
  const WB = '<?xml version="1.0"?><workbook xmlns="urn:x"><sheets/></workbook>';

  it('合法 pdf（%PDF- 头 + %%EOF 尾）→ 通过', () => {
    const p = path.join(tmp, 'ok.pdf');
    fs.writeFileSync(p, '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    expect(validateOfficeFile(p)).toEqual({ ok: true, errors: [] });
  });

  it('文本文件冒名 .pdf（无 %PDF- 头）→ 报错', () => {
    const p = path.join(tmp, 'fake.pdf');
    fs.writeFileSync(p, 'hello world, not a pdf');
    const r = validateOfficeFile(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('pdf'))).toBe(true);
  });

  it('截断 pdf（有头无 %%EOF 尾）→ 报可能截断', () => {
    const p = path.join(tmp, 'truncated.pdf');
    fs.writeFileSync(p, '%PDF-1.7\n1 0 obj\n<< >>\nendobj\n');
    const r = validateOfficeFile(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('%%EOF') || e.includes('截断'))).toBe(true);
  });
});

// rels 链一致性 + 索引越界（交付门禁补强 2026-11-04）：与元素序同属「Office
// 修复触发器」家族——rels 断链（指向不存在部件）与样式/共享字符串索引越界
// 均会触发「修复或删除不可读取的内容」；宽松解析器不报，须拦在交付前。
describe('momo-validate rels 链与索引越界（交付门禁）', () => {
  const R_XML = '<?xml version="1.0"?><Relationships xmlns="urn:x"/>';
  const WB = '<?xml version="1.0"?><workbook xmlns="urn:x"><sheets/></workbook>';
  const CT_EMPTY = CT_D;
  const CT_MISSING_DEFAULT = (part: string): string =>
    '<?xml version="1.0"?><Types xmlns="urn:x">' +
    `<Override PartName="${part}" ContentType="application/vnd.foo"/></Types>`;

  const sheetWith = (tail: string): string =>
    '<?xml version="1.0"?><worksheet xmlns="urn:x" xmlns:r="urn:r">' +
    `<sheetData>${tail}</sheetData><pageSetup/></worksheet>`;

  function xlsxWith(name: string, entries: Array<[string, string]>): string {
    return zipWrite(name, [
      ['[Content_Types].xml', CT_EMPTY],
      ['_rels/.rels', R_XML],
      ['xl/workbook.xml', WB],
      ...entries,
    ]);
  }

  it('rels 指向不存在部件 → 断链报错', () => {
    const rels = '<?xml version="1.0"?><Relationships xmlns="urn:x">' +
      '<Relationship Id="rId1" Type="urn:t/worksheet" Target="worksheets/sheet9.xml"/></Relationships>';
    const f = xlsxWith('rels-dangling.xlsx', [
      ['xl/_rels/workbook.xml.rels', rels],
      ['xl/worksheets/sheet1.xml', sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')],
    ]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('断链') && e.includes('sheet9.xml'))).toBe(true);
  });

  it('rels 相对路径（../）正确解析且目标存在 → 通过', () => {
    const rels = '<?xml version="1.0"?><Relationships xmlns="urn:x">' +
      '<Relationship Id="rId1" Type="urn:t/drawing" Target="../drawings/drawing1.xml"/></Relationships>';
    const f = xlsxWith('rels-rel-ok.xlsx', [
      ['xl/worksheets/sheet1.xml', sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')],
      ['xl/worksheets/_rels/sheet1.xml.rels', rels],
      ['xl/drawings/drawing1.xml', '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="urn:x"/>'],
    ]);
    expect(validateOfficeFile(f).ok).toBe(true);
  });

  it('rels TargetMode="External"（外链）不判断链', () => {
    const rels = '<?xml version="1.0"?><Relationships xmlns="urn:x">' +
      '<Relationship Id="rId1" Type="urn:t/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>';
    const f = xlsxWith('rels-ext.xlsx', [
      ['xl/worksheets/sheet1.xml', sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')],
      ['xl/worksheets/_rels/sheet1.xml.rels', rels],
    ]);
    expect(validateOfficeFile(f).ok).toBe(true);
  });

  it('部件无 ContentType（Override/Default 均未覆盖，如 .bin）→ 报错', () => {
    const f = zipWrite('ct-missing.xlsx', [
      ['[Content_Types].xml', CT_D],
      ['_rels/.rels', R_XML],
      ['xl/workbook.xml', WB],
      ['xl/worksheets/sheet1.xml', sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')],
      ['xl/media/blob.bin', 'BIN'],
    ]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('无 ContentType') && e.includes('blob.bin'))).toBe(true);
  });

  it('悬空 Override（pptxgenjs 预声明未写入部件）实测无害 → 不报', () => {
    const ct = '<?xml version="1.0"?><Types xmlns="urn:x">' +
      '<Default Extension="rels" ContentType="application/rel"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.foo"/></Types>';
    const f = zipWrite('ct-dangling-ok.xlsx', [
      ['[Content_Types].xml', ct],
      ['_rels/.rels', R_XML],
      ['xl/workbook.xml', WB],
      ['xl/worksheets/sheet1.xml', sheetWith('<row r="1"><c r="A1"><v>1</v></c></row>')],
    ]);
    expect(validateOfficeFile(f).ok).toBe(true);
  });

  const STYLES_2 = '<?xml version="1.0"?><styleSheet xmlns="urn:x">' +
    '<cellXfs count="2"><xf/><xf/></cellXfs></styleSheet>';
  const SHARED_2 = '<?xml version="1.0"?><sst xmlns="urn:x" count="2">' +
    '<si><t>甲</t></si><si><t>乙</t></si></sst>';

  function xlsxIdx(name: string, sheet: string): string {
    return xlsxWith(name, [
      ['xl/worksheets/sheet1.xml', sheet],
      ['xl/styles.xml', STYLES_2],
      ['xl/sharedStrings.xml', SHARED_2],
    ]);
  }

  it('样式索引越界（s=5 > cellXfs 2 项）→ 报错并给数值', () => {
    const bad = sheetWith('<row r="1"><c r="A1" s="5"><v>1</v></c></row>');
    const r = validateOfficeFile(xlsxIdx('idx-style-bad.xlsx', bad));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('样式索引越界') && e.includes('s=5'))).toBe(true);
  });

  it('共享字符串索引越界（t="s" v=42 > si 2 项）→ 报错', () => {
    const bad = sheetWith('<row r="1"><c r="A1" t="s"><v>42</v></c></row>');
    const r = validateOfficeFile(xlsxIdx('idx-shared-bad.xlsx', bad));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('共享字符串索引越界') && e.includes('42'))).toBe(true);
  });

  it('合法索引（s=1、t="s" v=1）→ 通过', () => {
    const good = sheetWith('<row r="1"><c r="A1" s="1" t="s"><v>1</v></c></row>');
    expect(validateOfficeFile(xlsxIdx('idx-good.xlsx', good)).ok).toBe(true);
  });
});
