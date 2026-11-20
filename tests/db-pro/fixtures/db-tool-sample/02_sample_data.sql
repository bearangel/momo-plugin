-- ============================================================
-- 样本测试包 02: 样本数据（源自 dape_dev_84 真实数据）
-- 用途：给 db 工具开发测试脚本执行 / 唯一键冲突 / 幂等 SKIP / 结果判定
-- 说明：
--   * REQUEST_MAPPING 为 JSON 列，真实值为 JSON 对象；
--     查询工具将其显示为 [object Object]（工具 JSON 展示缺陷，见问题清单）
--   * 三批数据时间线：
--       2026-10-30 S00957558 发票能力（已发布 90002/90003）
--       2026-10-31 S00958123 财务云 6 能力（已发布 90021-90026）
--       2026-11-17 UI 注册 90041-90045（已发布，含 fc_book_param_query → 与后续脚本撞唯一键）
--       2026-11-20 S00971511 本次（草稿 90031-90036）
-- ============================================================

-- ---------- ① DAP_E_MCP_ENDPOINT：8 条（含被复用的 91015/91016、会撞唯一键的 91115） ----------
INSERT INTO `dap_e_mcp_endpoint`
(ENDPOINT_ID, SERVICE_ID, HTTP_METHOD, PATH_PATTERN, GATEWAY_PATH, OPERATION_ID, SUMMARY, DESCRIPTION, TAG_NAME, INPUT_SCHEMA, ENDPOINT_STATUS, DEPRECATED, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(91015, 3008, 'GET', '/w/account/subject/findSubjectTreeWithTypeAndSpecial', '/dape/fc/w/account/subject/findSubjectTreeWithTypeAndSpecial', 'findSubjectTreeWithTypeAndSpecial', '科目树查询（含专项核算信息）', '科目树查询', '科目管理', NULL, 1, 0, '0', 0, 'system', '2026-10-31 10:57:11', 0),
(91016, 3008, 'POST', '/w/account/specialObject/findSpecialObjectPageByKeyWord', '/dape/fc/w/account/specialObject/findSpecialObjectPageByKeyWord', 'findSpecialObjectPageByKeyWord', '专项核算对象查询', '专项核算对象查询', '专项核算', NULL, 1, 0, '0', 0, 'system', '2026-10-31 10:57:11', 0),
(91113, 3008, 'POST', '/w/account/voucherTemplate/saveVoucherTemplate', '/dape/fc/w/account/voucherTemplate/saveVoucherTemplate', 'saveVoucherTemplate', '凭证转模板保存', '保存凭证模板', '凭证模板', NULL, 1, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(91114, 3008, 'POST', '/w/account/voucherTemplate/updateVoucherTemplate', '/dape/fc/w/account/voucherTemplate/updateVoucherTemplate', 'updateVoucherTemplateManage', '凭证模板分摊比例与业务事项保存', '更新凭证模板', '凭证模板', NULL, 1, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(91115, 3008, 'GET', '/w/account/bookParam/getBookParamList', '/dape/fc/w/account/bookParam/getBookParamList', 'getBookParamList', '查询账套参数', '查询账套参数', '账套参数', NULL, 1, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0);

-- 本次 S00971511 新注册 3 条（草稿 91021/91023/91024）
INSERT INTO `dap_e_mcp_endpoint`
(ENDPOINT_ID, SERVICE_ID, HTTP_METHOD, PATH_PATTERN, GATEWAY_PATH, OPERATION_ID, SUMMARY, DESCRIPTION, TAG_NAME, INPUT_SCHEMA, ENDPOINT_STATUS, DEPRECATED, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(91021, 3008, 'GET', '/w/account/voucher/findVoucherTypeByStatus', '/dape/fc/w/account/voucher/findVoucherTypeByStatus', 'findVoucherTypeByStatus', '凭证类型查询', '查询当前账套的凭证类型集合', '凭证管理', NULL, 1, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(91023, 3008, 'GET', '/w/account/voucher/findVoucherLockByYearAndMonth', '/dape/fc/w/account/voucher/findVoucherLockByYearAndMonth', 'findVoucherLockByYearAndMonth', '会计期间闭锁状态查询', '查询指定会计期间闭锁状态', '凭证管理', NULL, 1, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(91024, 3008, 'POST', '/w/account/voucher/saveVoucher', '/dape/fc/w/account/voucher/saveVoucher', 'saveVoucher', '保存凭证制单', '保存凭证制单（写操作）', '凭证管理', NULL, 1, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0);

-- ---------- ② DAP_E_MCP_TOOL：18 条（已发布 13 条 + 草稿 5 条） ----------
INSERT INTO `dap_e_mcp_tool`
(TOOL_ID, SERVICE_ID, TOOL_NAME, TOOL_TITLE, TOOL_DESCRIPTION, CATEGORY_CODE, CATEGORY_NAME, PERMISSION, RISK_LEVEL, READ_ONLY, IDEMPOTENT, DESTRUCTIVE, INPUT_SCHEMA, OUTPUT_SCHEMA, PUBLISH_STATUS, TOOL_VERSION, PERMISSION_CODE, VISIBLE_SCOPE, TENANT_WHITELIST, REVIEW_REQUIRED, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(90002, 3003, 'invoice_query_input_invoices', '进项发票查询', '查询进项发票台账', 'invoice', '发票管理', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-30 14:23:48', 0),
(90003, 3003, 'invoice_query_sales_invoices', '销项发票查询', '查询销项发票台账', 'invoice', '发票管理', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-30 14:23:48', 0),
(90021, 3008, 'fc_journal_query', '日记账查询', '查询日记账', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90022, 3008, 'fc_detail_ledger_query', '明细账查询（费用明细账）', '查询明细账', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90023, 3008, 'fc_special_detail_ledger_query', '专项核算明细账查询', '查询专项核算明细账', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90024, 3008, 'fc_account_book_query', '账套查询', '查询账套', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90025, 3008, 'fc_subject_tree_query', '科目树查询（含专项核算信息）', '查询科目树', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90026, 3008, 'fc_special_object_query', '专项核算对象查询', '查询专项核算对象', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-10-31 10:57:38', 0),
(90041, 3008, 'fc_voucher_template_class_list', '凭证模板分类树', '查询凭证模板分类树', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(90042, 3008, 'fc_voucher_template_list', '凭证模板列表查询', '查询凭证模板列表', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(90043, 3008, 'fc_voucher_template_save', '凭证转模板保存', '保存凭证模板（写）', 'fc', '财务云', 'write', 2, 0, 0, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(90044, 3008, 'fc_voucher_template_allocation_save', '凭证模板分摊比例与业务事项保存', '保存模板分摊（写）', 'fc', '财务云', 'write', 2, 0, 0, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0),
(90045, 3008, 'fc_book_param_query', '账套参数查询', '查询当前账套的账套参数列表（含会计制度、SFTJTDDJDD 开关、会计期间范围等）', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 2, 1, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-17 13:45:51', 0);

-- 本次 S00971511 草稿 5 条
INSERT INTO `dap_e_mcp_tool`
(TOOL_ID, SERVICE_ID, TOOL_NAME, TOOL_TITLE, TOOL_DESCRIPTION, CATEGORY_CODE, CATEGORY_NAME, PERMISSION, RISK_LEVEL, READ_ONLY, IDEMPOTENT, DESTRUCTIVE, INPUT_SCHEMA, OUTPUT_SCHEMA, PUBLISH_STATUS, TOOL_VERSION, PERMISSION_CODE, VISIBLE_SCOPE, TENANT_WHITELIST, REVIEW_REQUIRED, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(90031, 3008, 'voucher_type_list', '凭证类型查询', '查询当前账套已启用的凭证类型集合', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 0, 0, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(90032, 3008, 'account_subject_tree', '科目表查询', '查询当前账套科目树（含专项核算类型）', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 0, 0, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(90033, 3008, 'special_object_list', '专项核算对象查询', '按专项核算类型分页查询专项核算对象', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 0, 0, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(90035, 3008, 'account_period_status_check', '会计期间状态查询', '查询指定会计期间闭锁状态', 'fc', '财务云', 'readonly', 1, 1, 1, 0, NULL, NULL, 0, 0, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(90036, 3008, 'voucher_save', '保存凭证制单', '保存凭证制单（写操作，唯一有副作用）', 'fc', '财务云', 'write', 2, 0, 0, 1, NULL, NULL, 0, 0, NULL, 1, NULL, 0, '0', 0, 'system', '2026-11-20 11:10:19', 0);

-- ---------- ③ DAP_E_MCP_TOOL_BINDING：14 条（含复用端点绑定） ----------
INSERT INTO `dap_e_mcp_tool_binding`
(BINDING_ID, TOOL_ID, ENDPOINT_ID, STEP_NO, STEP_ROLE, REQUEST_MAPPING, RESPONSE_MAPPING, CONDITION_EXPR, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(91002, 90002, 90011, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-30 14:23:48', 0),
(91003, 90003, 90012, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-30 14:23:48', 0),
(92021, 90021, 91011, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92022, 90022, 91012, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92023, 90023, 91013, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92024, 90024, 91014, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92025, 90025, 91015, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92026, 90026, 91016, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-10-31 10:57:50', 0),
(92045, 90045, 91115, 1, 1, '{"placeholder":true}', NULL, NULL, '0', 0, 'system', '2026-11-17 13:45:51', 0);

-- 本次 S00971511 草稿 5 条（92032→91015、92033→91016 复用既有端点）
INSERT INTO `dap_e_mcp_tool_binding`
(BINDING_ID, TOOL_ID, ENDPOINT_ID, STEP_NO, STEP_ROLE, REQUEST_MAPPING, RESPONSE_MAPPING, CONDITION_EXPR, TENANT_ID, ORG_ID, CREATED_BY, CREATED_TIME, DELETED) VALUES
(92031, 90031, 91021, 1, 1, '{"accountYear":"accountYear","voucherTypeStatus":"voucherTypeStatus","accountNo":"accountNo"}', NULL, NULL, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(92032, 90032, 91015, 1, 1, '{"subjectTypeCode":"subjectTypeCode","accountNo":"accountNo","accountYear":"accountYear"}', NULL, NULL, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(92033, 90033, 91016, 1, 1, '{"accountYear":"accountYear","specialTypeCode":"specialTypeCode","specialClassId":"specialClassId","keyWord":"keyWord","searchType":"searchType","page":"page","pageSize":"pageSize"}', NULL, NULL, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(92035, 90035, 91023, 1, 1, '{"voucherYear":"voucherYear","voucherMonth":"voucherMonth"}', NULL, NULL, '0', 0, 'system', '2026-11-20 11:10:19', 0),
(92036, 90036, 91024, 1, 1, '{"voucherTypeNo":"voucherTypeNo","voucherDateYear":"voucherDateYear","voucherDateMonth":"voucherDateMonth","voucherDateDay":"voucherDateDay","voucherCode":"voucherCode","voucherAccessoryFrame":"voucherAccessoryFrame","voucherGenerateMode":"voucherGenerateMode","voucherDate":"voucherDate","accountYear":"accountYear","voucherExternalMark":"voucherExternalMark","accountNo":"accountNo","voucherNoteList":"voucherNoteList","voucherSpecialList":"voucherSpecialList","voucherSubsidiaryList":"voucherSubsidiaryList","voucherFileSaveBO":"voucherFileSaveBO","invoiceNumber":"invoiceNumber","invoiceCode":"invoiceCode","creatorId":"creatorId","confirm":"confirm"}', NULL, NULL, '0', 0, 'system', '2026-11-20 11:10:19', 0);

-- ---------- ④ DAP_E_SCRIPT_EXECUTION_LOG：4 条（3 失败 + 1 成功，完整排障样本） ----------
INSERT INTO `dap_e_script_execution_log`
(LOG_ID, SCRIPT_NO, EXECUTION_STATUS, EXECUTION_TIME, EXECUTOR, EXECUTION_REASON, ERROR_MESSAGE, TENANT_ID, CREATED_TIME) VALUES
(91, 'S00971511', 0, '2026-11-20 09:24:56', 'system', 'MCP能力注册：自然语言智能制证6个能力元数据种子脚本（4新ENDPOINT+2复用既有ENDPOINT）', '[?] Unknown error', '0', '2026-11-20 09:24:56'),
(92, 'S00971511', 0, '2026-11-20 10:02:25', 'system', 'MCP能力注册：自然语言智能制证5个能力元数据种子脚本（3新ENDPOINT+2复用既有ENDPOINT）', '[?] Unknown error', '0', '2026-11-20 10:02:25'),
(93, 'S00971511', 0, '2026-11-20 10:07:12', 'system', 'MCP能力注册：自然语言智能制证5个能力元数据种子脚本（3新ENDPOINT+2复用既有ENDPOINT）', '[HY000] Illegal mix of collations (utf8mb4_0900_ai_ci vs utf8mb4_unicode_ci)', '0', '2026-11-20 10:07:12'),
(94, 'S00971511', 1, '2026-11-20 11:10:19', 'system', 'MCP能力注册：自然语言智能制证5个能力元数据种子脚本（3新ENDPOINT+2复用既有ENDPOINT）', NULL, '0', '2026-11-20 11:10:19');