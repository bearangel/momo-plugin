// tests/email/utf7.test.ts
// IMAP modified UTF-7 最小解码（新浪等以 &...- 形式暴露文件夹名）
import { describe, expect, it } from 'vitest';
import { decodeModifiedUtf7 } from '../../plugins/email/service/lib/utf7';

describe('modified UTF-7', () => {
  it('解码 RFC 3501 &...- 段（含路径段）', () => {
    expect(decodeModifiedUtf7('&XfJT0ZAB-')).toBe('已发送');
    expect(decodeModifiedUtf7('&YhF2hJHNiYFlh072-')).toBe('我的重要文件');
    expect(decodeModifiedUtf7('&YhF2hJHNiYFlh072-/已发送')).toBe('我的重要文件/已发送');
  });

  it('ASCII 原样；&- 表字面 &', () => {
    expect(decodeModifiedUtf7('INBOX')).toBe('INBOX');
    expect(decodeModifiedUtf7('A&-B')).toBe('A&B');
  });

  it('非法段原样返回', () => {
    expect(decodeModifiedUtf7('&!!!-')).toBe('&!!!-');
    expect(decodeModifiedUtf7('&A-')).toBe('&A-');
    expect(decodeModifiedUtf7('A&B')).toBe('A&B');
  });
});
