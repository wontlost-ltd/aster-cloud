import { describe, it, expect } from 'vitest';
import { normalizeEmail, isSameMailbox, maskEmail } from '@/lib/email-normalize';

describe('normalizeEmail', () => {
  describe('gmail / googlemail', () => {
    it('剥离 +suffix', () => {
      expect(normalizeEmail('foo+spam@gmail.com')).toBe('foo@gmail.com');
    });

    it('去除 local-part 中的点', () => {
      expect(normalizeEmail('f.o.o@gmail.com')).toBe('foo@gmail.com');
    });

    it('+ 和 . 同时存在', () => {
      expect(normalizeEmail('f.o.o+x.y@gmail.com')).toBe('foo@gmail.com');
    });

    it('googlemail.com 与 gmail.com 视为同一域', () => {
      expect(normalizeEmail('foo@googlemail.com')).toBe('foo@gmail.com');
      expect(normalizeEmail('f.o.o+abc@googlemail.com')).toBe('foo@gmail.com');
    });

    it('大小写归一', () => {
      expect(normalizeEmail('Foo.Bar@Gmail.Com')).toBe('foobar@gmail.com');
    });
  });

  describe('其他域名', () => {
    it('保留 local-part 中的点（非 gmail 域名点不忽略）', () => {
      expect(normalizeEmail('foo.bar@aster-lang.dev')).toBe('foo.bar@aster-lang.dev');
    });

    it('剥离 +suffix（任何域名通用）', () => {
      expect(normalizeEmail('foo+spam@aster-lang.dev')).toBe('foo@aster-lang.dev');
    });

    it('toLowerCase', () => {
      expect(normalizeEmail('FOO@Aster-Lang.DEV')).toBe('foo@aster-lang.dev');
    });
  });

  describe('边界', () => {
    it('空字符串', () => {
      expect(normalizeEmail('')).toBe('');
    });

    it('无 @ → 原样 lower 返回', () => {
      expect(normalizeEmail('not-an-email')).toBe('not-an-email');
    });

    it('@ 在开头 → 原样 lower 返回', () => {
      expect(normalizeEmail('@gmail.com')).toBe('@gmail.com');
    });

    it('两端空白被剥离', () => {
      expect(normalizeEmail('  foo+bar@gmail.com  ')).toBe('foo@gmail.com');
    });
  });

  describe('反多重注册场景（去重一致性）', () => {
    it('同一人的 5 种 gmail 写法归一为一个', () => {
      const variants = [
        'attacker@gmail.com',
        'attacker+aster1@gmail.com',
        'attacker+aster2@gmail.com',
        'a.t.t.a.c.k.e.r@gmail.com',
        'attacker@googlemail.com',
      ];
      const normalized = variants.map(normalizeEmail);
      const unique = new Set(normalized);
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe('attacker@gmail.com');
    });
  });
});

describe('isSameMailbox（团队邀请按同一邮箱匹配，#682）', () => {
  it('大小写与两端空白不同仍是同一邮箱', () => {
    expect(isSameMailbox(' Ryan.Pang@Wontlost.com ', 'ryan.pang@wontlost.com')).toBe(true);
  });

  it('+别名与基地址是同一邮箱（与注册去重同一口径）', () => {
    expect(isSameMailbox('ryan.pang+team@wontlost.com', 'ryan.pang@wontlost.com')).toBe(true);
    expect(isSameMailbox('f.o.o+x@gmail.com', 'foo@googlemail.com')).toBe(true);
  });

  it('不同 local-part 或不同域名不是同一邮箱', () => {
    expect(isSameMailbox('ryanpang@wontlost.com', 'ryan.pang@wontlost.com')).toBe(false);
    expect(isSameMailbox('ryan.pang@wontlost.com', 'ryan.pang@wontlost.dev')).toBe(false);
  });

  it('空值永不匹配', () => {
    expect(isSameMailbox('', '')).toBe(false);
    expect(isSameMailbox(null, 'a@b.c')).toBe(false);
    expect(isSameMailbox('a@b.c', undefined)).toBe(false);
  });
});

describe('maskEmail（注册 409 的已有账号提示，#682）', () => {
  it('+别名：保留首字符、后缀前 3 个字符与域名', () => {
    expect(maskEmail('ryan.pang+adr0051-retest@wontlost.com')).toBe('r***+adr…@wontlost.com');
  });
  it('短后缀不加省略号', () => {
    expect(maskEmail('ab+x@ex.com')).toBe('a***+x@ex.com');
  });
  it('无 +后缀', () => {
    expect(maskEmail('ryan.pang@wontlost.com')).toBe('r***@wontlost.com');
  });
  it('非法输入不抛错', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
