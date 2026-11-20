/**
 * 文件名: S00971511.sql
 * 描述: MCP 元数据驱动框架——注册《自然语言智能制证》技能依赖的 5 个制证能力（纯 DML 种子脚本）
 *       1. DAP_E_MCP_ENDPOINT 新增 3 条：91021 凭证类型 / 91023 会计期间闭锁状态 / 91024 保存凭证
 *          （SERVICE_ID=3008 fc-service 已存在，不重复插入 SERVICE）
 *          另 2 个工具复用既有 ENDPOINT：91015 科目树（S00958123 已注册）、91016 专项核算对象（S00958123 已注册），不重复插入
 *       2. DAP_E_MCP_TOOL 5 条：voucher_type_list(90031) / account_subject_tree(90032) / special_object_list(90033)
 *          / account_period_status_check(90035) / voucher_save(90036)，草稿态(PUBLISH_STATUS=0)
 *       3. DAP_E_MCP_TOOL_BINDING 5 条：92031/92032/92033/92035/92036（92032→91015、92033→91016 复用既有 ENDPOINT），全字段透传 REQUEST_MAPPING
 *       幂等策略：依赖 DAP_E_SCRIPT_EXECUTION_LOG 已成功执行则整体跳过（沿用 S00957558 模板），
 *                 故采用 INSERT INTO（非 INSERT IGNORE）；若目标库已存在主键/唯一键冲突，将整体回滚报错提示人工处理。
 * 作者: AI
 * 创建时间: 2026-11-19
 * 适用范围: MCP服务(dape-mcp)
 * 说明:
 *   - 所有表 TENANT_ID='0'、ORG_ID=0、CREATED_BY='system'、DELETED=0
 *   - ENDPOINT.INPUT_SCHEMA 为标准 JSON Schema（CapabilityToolProvider 直接消费，作为 MCP 工具入参）
 *   - TOOL.INPUT_SCHEMA 为 JSON 数组 [{name,type,required,description},...]（管理端展示用）
 *   - 账套传递约定：FC 各接口接收 accountNo(账套代码)，实际运行时由 dape-mcp 侧一次性 token
 *     注入 UserContext 传递用户当前账套，body/query 中的 accountNo 字段被下游忽略，仅作能力入参占位（沿用 S00958123 约定）。
 *   - 写工具 voucher_save(90036) 为本批唯一有副作用的工具：PERMISSION=write、RISK_LEVEL=2、READ_ONLY=0、
 *     IDEMPOTENT=0、DESTRUCTIVE=1；REVIEW_REQUIRED=0（技能层 VoucherSaveConfirm 已做二次确认，工具层不叠加人工复核，避免双确认）。
 *   - 账套参数能力复用 dev 库已发布工具 fc_book_param_query(90045)，本脚本不再重复注册
 *   - ID 规划：新 ENDPOINT 91021/91023/91024、TOOL 90031/90032/90033/90035/90036、BINDING 92031/92032/92033/92035/92036；
 *     与 S00957558（ENDPOINT 90011/90012、TOOL 90002/90003、BINDING 91002/91003）、
 *     S00958123（ENDPOINT 91011-91016、TOOL 90021-90026、BINDING 92021-92026）不冲突（本规划已避开）。
 **/

-- ============================================================
-- 设置执行参数（执行前修改这三行）
-- ============================================================
SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;
SET @__script_no = 'S00971511';
SET @__executor = 'system';
SET @__reason = 'MCP能力注册：自然语言智能制证5个能力元数据种子脚本（3新ENDPOINT+2复用既有ENDPOINT，账套参数复用已发布fc_book_param_query）';

-- ============================================================
-- 存储过程：自带跳过逻辑 + 事务 + 错误处理 + 执行记录
-- ============================================================
DROP PROCEDURE IF EXISTS sp_exec_script;
DELIMITER //

CREATE PROCEDURE sp_exec_script()
BEGIN
    DECLARE v_success_count INT DEFAULT 0;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1
            @__err_code = RETURNED_SQLSTATE,
            @__err_msg = MESSAGE_TEXT;
        ROLLBACK;
        INSERT INTO DAP_E_SCRIPT_EXECUTION_LOG
        (SCRIPT_NO, EXECUTION_STATUS, EXECUTION_TIME, EXECUTOR, EXECUTION_REASON, ERROR_MESSAGE, TENANT_ID, CREATED_TIME)
        VALUES (@__script_no, 0, NOW(), @__executor, @__reason,
                CONCAT('[', IFNULL(@__err_code, '?'), '] ', IFNULL(@__err_msg, 'Unknown error')), '0', NOW());
        SELECT CONCAT('[FAIL] ', @__script_no, ' -- [', IFNULL(@__err_code, '?'), '] ', IFNULL(@__err_msg, 'Unknown error')) AS execution_status;
    END;

    SELECT COUNT(*) INTO v_success_count FROM DAP_E_SCRIPT_EXECUTION_LOG
    WHERE SCRIPT_NO = @__script_no AND EXECUTION_STATUS = 1;

    IF v_success_count > 0 THEN
        SELECT CONCAT('[SKIP] ', @__script_no, ' -- Already executed successfully, skipping') AS execution_status;
    ELSE
        START TRANSACTION;

        -- >>> 脚本内容开始 <<<
        SET FOREIGN_KEY_CHECKS = 0;

        -- ============================================================
        -- ① DAP_E_MCP_ENDPOINT：智能制证 3 个新接口元数据（91021/91023/91024）
        --    人工种子固定小整数主键（ENDPOINT_ID），与雪花主键并存不冲突
        --    GATEWAY_PATH = /dape/fc(网关前缀) + PATH_PATTERN(服务内路径)
        --    91015（科目树）/91016（专项核算对象）由 S00958123 已注册，本批直接复用，不重复插入
        -- ============================================================
        INSERT INTO DAP_E_MCP_ENDPOINT
        (ENDPOINT_ID, SERVICE_ID, HTTP_METHOD, PATH_PATTERN, GATEWAY_PATH, OPERATION_ID, SUMMARY, DESCRIPTION,
         TAG_NAME, INPUT_SCHEMA, ENDPOINT_STATUS, DEPRECATED, TENANT_ID, ORG_ID, CREATED_BY, DELETED)
        VALUES
        (91021, 3008, 'GET', '/w/account/voucher/findVoucherTypeByStatus', '/dape/fc/w/account/voucher/findVoucherTypeByStatus', 'findVoucherTypeByStatus',
         '凭证类型查询',
         '查询当前账套的凭证类型集合（类型代码 voucherTypeNo+全称 voucherFullName+简称 voucherAbbreviation+是否启用 isVoucherWhetherEnable），支持按启用状态过滤。制证时凭证类型先查后判：仅 1 个直接取用、多个按业务推导并与启用集合比对。',
         '凭证管理',
         JSON_OBJECT('type','object','properties',
             JSON_OBJECT('accountYear',JSON_OBJECT('type','string','description','账套年度 YYYY'),
                         'voucherTypeStatus',JSON_OBJECT('type','integer','description','凭证类型状态：1=启用（有效）/0=停用，技能场景取 1'),
                         'accountNo',JSON_OBJECT('type','string','description','账套代码，GET query 直接传参，省略=当前账套'))),
         1, 0, '0', 0, 'system', 0),
        (91023, 3008, 'GET', '/w/account/voucher/findVoucherLockByYearAndMonth', '/dape/fc/w/account/voucher/findVoucherLockByYearAndMonth', 'findVoucherLockByYearAndMonth',
         '会计期间闭锁状态查询',
         '查询指定会计期间（年+月）的凭证闭锁状态，返回闭锁标志 lockedSign（1=已闭锁/已结账，不可制证）+闭锁信息。制证强制前置校验：期间已闭锁则 blocked 并提示用户切换期间，不生成草稿。',
         '凭证管理',
         JSON_OBJECT('type','object','properties',
             JSON_OBJECT('voucherYear',JSON_OBJECT('type','string','description','凭证年 YYYY'),
                         'voucherMonth',JSON_OBJECT('type','string','description','凭证月 MM'))),
         1, 0, '0', 0, 'system', 0),
        (91024, 3008, 'POST', '/w/account/voucher/saveVoucher', '/dape/fc/w/account/voucher/saveVoucher', 'saveVoucher',
         '保存凭证制单',
         '保存凭证制单（落库），入参对齐 VoucherBO 结构（凭证头+分录 voucherNoteList+专项核算 voucherSpecialList+辅助核算 voucherSubsidiaryList+附件 voucherFileSaveBO），返回保存结果（凭证 GID+限额检查结果）。本接口为写操作，调用前必须已完成用户显式确认。',
         '凭证管理',
         JSON_OBJECT('type','object','properties',
             JSON_OBJECT('voucherTypeNo',JSON_OBJECT('type','integer','description','凭证类型代码，来自 voucher_type_list'),
                         'voucherDateYear',JSON_OBJECT('type','integer','description','凭证日期年 YYYY'),
                         'voucherDateMonth',JSON_OBJECT('type','integer','description','凭证日期月（1-12）'),
                         'voucherDateDay',JSON_OBJECT('type','integer','description','凭证日期日（1-31）'),
                         'voucherCode',JSON_OBJECT('type','integer','description','凭证号（可选，缺省由系统生成）'),
                         'voucherAccessoryFrame',JSON_OBJECT('type','integer','description','附件张数，口述场景固定 0'),
                         'voucherGenerateMode',JSON_OBJECT('type','integer','description','生成模式，固定 0=分别生成'),
                         'voucherDate',JSON_OBJECT('type','string','description','业务日期，格式 YYYY-MM-DD'),
                         'accountYear',JSON_OBJECT('type','string','description','会计年度 YYYY'),
                         'voucherExternalMark',JSON_OBJECT('type','string','description','外部标识（可选）'),
                         'accountNo',JSON_OBJECT('type','string','description','账套代码，经一次性 token 在 dape-mcp 侧注入 UserContext 传递，body 中该字段被忽略'),
                         'voucherNoteList',JSON_OBJECT('type','array','description','分录列表，元素含：voucherNoteIndex(integer,分录序号从1递增)、subjectCode(string,科目代码)、debitCreditSides(integer,借贷方向 D借=0/C贷=1)、amount(string,发生额字符串保留2位小数)、quantity(number,可选默认0)、quantityPrice(number,可选默认0)、foreignCurrencyAmount(number,可选默认0)、forex(number,可选默认0)、voucherSummary(string,行摘要)'),
                         'voucherSpecialList',JSON_OBJECT('type','array','description','专项核算挂接列表（可选），元素含：voucherNoteIndex(integer)、subjectCode(string)、amount(string)、specialTypeOne/Two/Three(integer,专项核算类型1-3槽)、objectIdOne/Two/Three(integer,对象ID1-3槽)、accountYear(string)、operateType(integer)'),
                         'voucherSubsidiaryList',JSON_OBJECT('type','array','description','辅助核算挂接列表（可选），元素含：voucherNoteIndex(integer)、subjectCode(string)、subsidiarySubjectCode(string)、subsidiarySubjectName(string)、subsidiarySubjectTypeCode(string)、amount(string)、accountYear(string)、operateType(integer)'),
                         'voucherFileSaveBO',JSON_OBJECT('type','object','description','附件对象，口述场景固定为空附件对象（voucherId 空、voucherFileDetails 空数组）'),
                         'invoiceNumber',JSON_OBJECT('type','string','description','发票号码，口述场景恒为空串'),
                         'invoiceCode',JSON_OBJECT('type','string','description','发票代码，口述场景恒为空串'),
                         'creatorId',JSON_OBJECT('type','integer','description','创建人ID（可选）'),
                         'confirm',JSON_OBJECT('type','boolean','description','二次确认标记（可选，技能层已确认）'))),
         1, 0, '0', 0, 'system', 0);

        -- ============================================================
        -- ② DAP_E_MCP_TOOL：自然语言智能制证 5 个工具元数据（草稿态，待运营发布）
        --    PUBLISH_STATUS=0 草稿；只读 4 个工具 RISK_LEVEL=1、READ_ONLY=1、IDEMPOTENT=1、DESTRUCTIVE=0；
        --    写工具 voucher_save(90036) RISK_LEVEL=2、READ_ONLY=0、IDEMPOTENT=0、DESTRUCTIVE=1、REVIEW_REQUIRED=0
        --    TOOL.INPUT_SCHEMA 为数组格式（管理端展示用），required 标记与入参语义对齐
        -- ============================================================
        INSERT INTO DAP_E_MCP_TOOL
        (TOOL_ID, SERVICE_ID, TOOL_NAME, TOOL_TITLE, TOOL_DESCRIPTION, CATEGORY_CODE, CATEGORY_NAME,
         PERMISSION, RISK_LEVEL, READ_ONLY, IDEMPOTENT, DESTRUCTIVE, INPUT_SCHEMA, PUBLISH_STATUS,
         VISIBLE_SCOPE, REVIEW_REQUIRED, TENANT_ID, ORG_ID, CREATED_BY, DELETED)
        VALUES
        (90031, 3008, 'voucher_type_list', '凭证类型查询',
         '查询当前账套已启用的凭证类型集合（类型代码 voucherTypeNo+全称 voucherFullName+简称 voucherAbbreviation+是否启用 isVoucherWhetherEnable）。制证时凭证类型先查后判：仅 1 个直接取用、多个按业务推导并与启用集合比对。路由词：凭证类型、记账凭证、收付款凭证。accountNo 走 GET query 直接传参（缺省当前账套）。返回结果 voucherTypeNo 作为 voucher_save 的 voucherTypeNo 入参。',
         'fc', '财务云',
         'readonly', 1, 1, 1, 0,
         JSON_ARRAY(
             JSON_OBJECT('name','accountYear','type','string','required',true,'description','账套年度 YYYY'),
             JSON_OBJECT('name','voucherTypeStatus','type','integer','required',false,'description','凭证类型状态：1=启用（有效）/0=停用，技能场景取 1'),
             JSON_OBJECT('name','accountNo','type','string','required',false,'description','账套代码，GET query 直接传参，省略=当前账套')),
         0, 1, 0, '0', 0, 'system', 0),
        (90032, 3008, 'account_subject_tree', '科目表查询',
         '查询当前账套科目树（科目代码+名称+科目级别+专项核算类型 subjectRelevanceSpecialTypeVOS），用于科目名称→subjectCode 映射、校验科目存在/末级/性质。路由词：科目、科目表、科目树、科目代码。返回含 subjectRelevanceSpecialTypeVOS（专项核算类型），供 special_object_list 取 specialTypeCode。',
         'fc', '财务云',
         'readonly', 1, 1, 1, 0,
         JSON_ARRAY(
             JSON_OBJECT('name','subjectTypeCode','type','integer','required',false,'description','科目分类，可省略=全部分类'),
             JSON_OBJECT('name','accountNo','type','string','required',false,'description','账套代码，GET query 直接传参，省略=当前账套'),
             JSON_OBJECT('name','accountYear','type','string','required',false,'description','账套年度，省略=当前年度')),
         0, 1, 0, '0', 0, 'system', 0),
        (90033, 3008, 'special_object_list', '专项核算对象查询',
         '按专项核算类型+关键字分页查询专项核算对象（ID+代码+名称）。【调用前必读：必须先经 account_subject_tree 取得科目 subjectRelevanceSpecialTypeVOS[].specialTypeCode】，作为本工具 specialTypeCode 必传入参；返回 specialObjectId 供制证分录专项核算挂接。必填：accountYear、specialTypeCode、specialClassId（不限传 -1）。',
         'fc', '财务云',
         'readonly', 1, 1, 1, 0,
         JSON_ARRAY(
             JSON_OBJECT('name','accountYear','type','string','required',true,'description','账套年度，格式 yyyy'),
             JSON_OBJECT('name','specialTypeCode','type','integer','required',true,'description','专项核算类型编码，来自 account_subject_tree 返回的 subjectRelevanceSpecialTypeVOS[].specialTypeCode'),
             JSON_OBJECT('name','specialClassId','type','integer','required',true,'description','专项核算分类ID，不限时传 -1'),
             JSON_OBJECT('name','keyWord','type','string','required',false,'description','对象代码/名称模糊关键字'),
             JSON_OBJECT('name','searchType','type','integer','required',false,'description','搜索方式：0=按代码/1=按名称'),
             JSON_OBJECT('name','page','type','integer','required',false,'description','页码，默认0'),
             JSON_OBJECT('name','pageSize','type','integer','required',false,'description','每页条数，默认20')),
         0, 1, 0, '0', 0, 'system', 0),
        (90035, 3008, 'account_period_status_check', '会计期间状态查询',
         '查询指定会计期间（年+月）的凭证闭锁状态，返回闭锁标志 lockedSign（1=已闭锁/已结账，不可制证）+闭锁信息。制证强制前置校验：期间已闭锁则 blocked 并提示用户切换期间，不生成草稿。路由词：期间、闭锁、结账、会计期间。',
         'fc', '财务云',
         'readonly', 1, 1, 1, 0,
         JSON_ARRAY(
             JSON_OBJECT('name','voucherYear','type','string','required',true,'description','凭证年 YYYY'),
             JSON_OBJECT('name','voucherMonth','type','string','required',true,'description','凭证月 MM')),
         0, 1, 0, '0', 0, 'system', 0),
        (90036, 3008, 'voucher_save', '保存凭证制单',
         '保存凭证制单（落库），返回保存结果（凭证 GID+限额检查结果）。【唯一有副作用的写工具】：调用前必须已完成用户显式确认（CONFIRM），不得静默调用；调用方需先经 voucher_type_list/account_subject_tree/account_period_status_check 等前置校验。路由词：保存凭证、生成凭证、入账。',
         'fc', '财务云',
         'write', 2, 0, 0, 1,
         JSON_ARRAY(
             JSON_OBJECT('name','voucherTypeNo','type','integer','required',true,'description','凭证类型代码，来自 voucher_type_list'),
             JSON_OBJECT('name','voucherDateYear','type','integer','required',true,'description','凭证日期年 YYYY'),
             JSON_OBJECT('name','voucherDateMonth','type','integer','required',true,'description','凭证日期月（1-12）'),
             JSON_OBJECT('name','voucherDateDay','type','integer','required',true,'description','凭证日期日（1-31）'),
             JSON_OBJECT('name','voucherCode','type','integer','required',false,'description','凭证号（可选，缺省由系统生成）'),
             JSON_OBJECT('name','voucherAccessoryFrame','type','integer','required',true,'description','附件张数，口述场景固定 0'),
             JSON_OBJECT('name','voucherGenerateMode','type','integer','required',true,'description','生成模式，固定 0=分别生成'),
             JSON_OBJECT('name','voucherDate','type','string','required',true,'description','业务日期，格式 YYYY-MM-DD'),
             JSON_OBJECT('name','accountYear','type','string','required',true,'description','会计年度 YYYY'),
             JSON_OBJECT('name','voucherExternalMark','type','string','required',false,'description','外部标识（可选）'),
             JSON_OBJECT('name','accountNo','type','string','required',true,'description','账套代码，经一次性 token 在 dape-mcp 侧注入 UserContext 传递，body 中该字段被忽略'),
             JSON_OBJECT('name','voucherNoteList','type','array','required',true,'description','分录列表，元素含：voucherNoteIndex(integer,分录序号从1递增)、subjectCode(string,科目代码)、debitCreditSides(integer,借贷方向 D借=0/C贷=1)、amount(string,发生额字符串保留2位小数)、quantity(number,可选默认0)、quantityPrice(number,可选默认0)、foreignCurrencyAmount(number,可选默认0)、forex(number,可选默认0)、voucherSummary(string,行摘要)'),
             JSON_OBJECT('name','voucherSpecialList','type','array','required',false,'description','专项核算挂接列表（可选），元素含：voucherNoteIndex(integer)、subjectCode(string)、amount(string)、specialTypeOne/Two/Three(integer,专项核算类型1-3槽)、objectIdOne/Two/Three(integer,对象ID1-3槽)、accountYear(string)、operateType(integer)'),
             JSON_OBJECT('name','voucherSubsidiaryList','type','array','required',false,'description','辅助核算挂接列表（可选），元素含：voucherNoteIndex(integer)、subjectCode(string)、subsidiarySubjectCode(string)、subsidiarySubjectName(string)、subsidiarySubjectTypeCode(string)、amount(string)、accountYear(string)、operateType(integer)'),
             JSON_OBJECT('name','voucherFileSaveBO','type','object','required',true,'description','附件对象，口述场景固定为空附件对象（voucherId 空、voucherFileDetails 空数组）'),
             JSON_OBJECT('name','invoiceNumber','type','string','required',true,'description','发票号码，口述场景恒为空串'),
             JSON_OBJECT('name','invoiceCode','type','string','required',true,'description','发票代码，口述场景恒为空串'),
             JSON_OBJECT('name','creatorId','type','integer','required',false,'description','创建人ID（可选）'),
             JSON_OBJECT('name','confirm','type','boolean','required',false,'description','二次确认标记（可选，技能层已确认）')),
         0, 1, 0, '0', 0, 'system', 0);

        -- ============================================================
        -- ③ DAP_E_MCP_TOOL_BINDING：工具与接口绑定（单步骤主执行）
        --    REQUEST_MAPPING 全字段透传：key=接口参数名，value=工具参数名
        --    92032→91015、92033→91016 复用 S00958123 已注册的既有 ENDPOINT
        -- ============================================================
        INSERT INTO DAP_E_MCP_TOOL_BINDING
        (BINDING_ID, TOOL_ID, ENDPOINT_ID, STEP_NO, STEP_ROLE, REQUEST_MAPPING, RESPONSE_MAPPING, CONDITION_EXPR,
         TENANT_ID, ORG_ID, CREATED_BY, DELETED)
        VALUES
        (92031, 90031, 91021, 1, 1,
         JSON_OBJECT('accountYear','accountYear','voucherTypeStatus','voucherTypeStatus','accountNo','accountNo'),
         NULL, NULL, '0', 0, 'system', 0),
        (92032, 90032, 91015, 1, 1,
         JSON_OBJECT('subjectTypeCode','subjectTypeCode','accountNo','accountNo','accountYear','accountYear'),
         NULL, NULL, '0', 0, 'system', 0),
        (92033, 90033, 91016, 1, 1,
         JSON_OBJECT('accountYear','accountYear','specialTypeCode','specialTypeCode','specialClassId','specialClassId',
                     'keyWord','keyWord','searchType','searchType','page','page','pageSize','pageSize'),
         NULL, NULL, '0', 0, 'system', 0),
        (92035, 90035, 91023, 1, 1,
         JSON_OBJECT('voucherYear','voucherYear','voucherMonth','voucherMonth'),
         NULL, NULL, '0', 0, 'system', 0),
        (92036, 90036, 91024, 1, 1,
         JSON_OBJECT('voucherTypeNo','voucherTypeNo','voucherDateYear','voucherDateYear','voucherDateMonth','voucherDateMonth',
                     'voucherDateDay','voucherDateDay','voucherCode','voucherCode','voucherAccessoryFrame','voucherAccessoryFrame',
                     'voucherGenerateMode','voucherGenerateMode','voucherDate','voucherDate','accountYear','accountYear',
                     'voucherExternalMark','voucherExternalMark','accountNo','accountNo','voucherNoteList','voucherNoteList',
                     'voucherSpecialList','voucherSpecialList','voucherSubsidiaryList','voucherSubsidiaryList',
                     'voucherFileSaveBO','voucherFileSaveBO','invoiceNumber','invoiceNumber','invoiceCode','invoiceCode',
                     'creatorId','creatorId','confirm','confirm'),
         NULL, NULL, '0', 0, 'system', 0);

        SET FOREIGN_KEY_CHECKS = 1;
        -- >>> 脚本内容结束 <<<

        COMMIT;

        INSERT INTO DAP_E_SCRIPT_EXECUTION_LOG
        (SCRIPT_NO, EXECUTION_STATUS, EXECUTION_TIME, EXECUTOR, EXECUTION_REASON, TENANT_ID, CREATED_TIME)
        VALUES (@__script_no, 1, NOW(), @__executor, @__reason, '0', NOW());
    END IF;
END //

DELIMITER ;

-- 调用存储过程
CALL sp_exec_script();

-- 清理
DROP PROCEDURE IF EXISTS sp_exec_script;