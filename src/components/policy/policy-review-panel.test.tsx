import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * 复核面板（ADR 0037 §14/§15）。
 *
 * <h2>这里测的都是**安全相关**的行为，不是像素</h2>
 *
 * <ul>
 *   <li>无权查看 → <b>自隐藏</b>（不渲染"你没有权限"的空壳）</li>
 *   <li>非复核人 → <b>不渲染任何提交控件</b>（与服务端 403 一致）</li>
 *   <li>空理由 → 前端先拦（服务端仍是权威，两处都要）</li>
 *   <li>缺 contentHash 的候选 → <b>不进队列</b>（否则点了才发现签不了）</li>
 *   <li>提交请求体必须带 nodeId/contentHash/span —— 少一样服务端就会拒</li>
 * </ul>
 *
 * <p>★i18n 用 key 直返（与 policy-alias-panel.test.tsx 同范式），
 * 断言对 key 而非中文文案——文案会改，行为不该跟着改。
 *
 * <h2>★这里**不再 mock 引擎**</h2>
 *
 * <p>上一版 `vi.mock('@aster-cloud/aster-lang-ts')` 掉了整个引擎，
 * 于是 24 条测试全绿，而真实页面 500 —— 引擎经 `node:crypto` 拉进
 * `node:fs`，webpack 不肯打进客户端包。**是视觉验证抓到的，不是单测。**
 *
 * <p>队列现在由服务端算，组件只消费 fetch 回来的 JSON。
 * 测试因此驱动的是真实的组件契约（HTTP 响应），而不是一个被我
 * 替换掉的模块——mock 的边界越靠外，能骗过测试的东西就越少。
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { PolicyReviewPanel } from './policy-review-panel';

const HASH = 'a'.repeat(64);

/** 一条待复核项（**服务端**返回的形状）。 */
function item(over: Record<string, unknown> = {}) {
  return {
    // ★span 起点**非零**，且 start / end / text.length 三者互不相等。
    //   用 `{start:0, end:text.length}` 的话，"原样传递"与"由 text 推导"
    //   数值相同，提交时重算 span 这个缺陷会完全隐身。
    text: '10000', nodeId: '$.a', span: { start: 37, end: 42 },
    reason: '机器证不了', contentHash: HASH,
    ...over,
  };
}

/** 一个完整的 GET /review 响应体。 */
function reviewBody(over: Record<string, unknown> = {}) {
  return {
    items: [item()],
    counts: { verified: 1, reviewRequired: 1, rejected: 0 },
    canReview: true, subjectKind: 'domain_expert', proofs: [],
    queueStatus: 'ok',
    ...over,
  };
}

/**
 * 装一个 review API 的 fetch。
 *
 * `postStatus` 让 GET 成功而 POST 失败——提交失败路径必须能单独驱动，
 * 否则「服务端拒绝了但界面看起来像成功」这类缺陷无从断言。
 */
function stubFetch(res: { status?: number; body?: unknown; postStatus?: number }) {
  const fn = vi.fn().mockImplementation((_url: string, init?: { method?: string }) => {
    const isPost = init?.method === 'POST';
    const status = isPost ? (res.postStatus ?? 200) : (res.status ?? 200);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: async () => (isPost ? { recorded: true } : (res.body ?? reviewBody())),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('复核面板 — 可见性', () => {
  it('★无权查看（404）必须整块隐藏，不渲染空壳', async () => {
    // 渲染"你没有权限"会让不相关用户每次打开策略都看到噪声。
    const fetchFn = stubFetch({ status: 404 });
    const { container } = render(<PolicyReviewPanel policyId="p1" />);

    // ★必须等 fetch 真的发生过再断言。否则 `firstChild === null` 会被
    //   **初始状态**（visible 尚为 null，本来就不渲染）满足——
    //   等于什么都没验证：把 404 分支改成"渲染错误面板"也照样绿。
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText('loadFailed'), '不得退化成错误面板').toBeNull();
  });

  it('未登录（401）同样隐藏', async () => {
    const fetchFn = stubFetch({ status: 401 });
    const { container } = render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText('loadFailed')).toBeNull();
  });

  it('★权限未知（请求在途）期间不得渲染任何东西', () => {
    // ★三态 `null | true | false` 里的 `null`（权限未知）从没被断言过：
    //   既有两条用例都 `await waitFor(fetch 已调用)` 之后才看终态。
    //   于是把守卫从 `visible !== true` 放宽成 `visible === false`，全绿——
    //   而那意味着无权查看的用户每次打开策略详情页都会**闪现**一个
    //   空壳复核面板（标题 + 副标题 + 三个全 0 徽标），正是自隐藏要防的噪声。
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));   // 永不 resolve
    const { container } = render(<PolicyReviewPanel policyId="p1" />);

    expect(container.firstChild, '权限未知时就渲染了面板').toBeNull();
  });

  it('有权查看时渲染标题与三类计数', async () => {
    // ★`reviewRequired` 必须**不等于** items.length（默认 1 条）。
    //   相等时，"渲染 counts.reviewRequired"与"渲染 items.length"不可区分——
    //   注释挑明防的是**加法**（1+1=2 会红），却漏了**替换**。
    //   真实数据里两者经常不等：被 contentHash 过滤掉的候选不进 items，
    //   却仍计入引擎的 summary。徽标显示"待复核 0"而引擎其实判了 3 条
    //   机器证不了、只是都签不下去——又一条 fail-open。
    stubFetch({ body: reviewBody({ counts: { verified: 7, reviewRequired: 4, rejected: 3 } }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('title')).toBeDefined());
    // ★三个数字都要逐字断言且**互不相同**——否则把 verified 与 rejected
    //   对调、或写死成常量，都不会有任何用例变红。
    //   `getByText(/verified/)` 只匹配标签，数字完全不参与。
    expect(screen.getByText('verified: 7')).toBeDefined();
    expect(screen.getByText('rejected: 3')).toBeDefined();
    // ★counts 与 items 同源，**不得相加**。服务端给 reviewRequired:1 且
    //   items 有 1 条；若实现写成 `counts.reviewRequired + items.length`
    //   这里就会是 2。
    expect(screen.getByText('reviewRequired: 4')).toBeDefined();
  });
});

describe('复核面板 — policyId 必须流到请求 URL', () => {
  // ★64 条用例全部 `render(<PolicyReviewPanel policyId="p1" />)`，
  //   却**从不看 `fetch.mock.calls[i][0]`（URL）**——只看 method 和 body。
  //   于是把两处 fetch 的路径写死成别的策略，全部照样绿。
  //   这正是接线门禁想防的那个危害（"所有人对同一条错误策略签字"），
  //   而组件内部的同一个危害完全没锁：门禁只证明了 policy.id 进了 prop，
  //   没人证明 prop 流到了 URL —— 只验中间态。

  it('★GET 与 POST 都必须打到 /api/policies/:policyId/review', async () => {
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    expect(fetchFn.mock.calls[0][0]).toBe('/api/policies/p1/review');

    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: '核对无误。' } });
    fireEvent.click(screen.getByText('accept'));

    await waitFor(() => {
      const post = fetchFn.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === 'POST',
      );
      expect(post, '应发出 POST').toBeDefined();
      expect(post![0]).toBe('/api/policies/p1/review');
    });
  });

  it('★URL 必须**随 prop 变化**（否则写死 "p1" 又是一次恒真）', async () => {
    // 只断言等于 '/api/policies/p1/review' 的话，把 URL 写死成那个字面量
    // 同样能过。必须用第二个 policyId 证明它真的来自 prop。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="another-policy" />);

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(fetchFn.mock.calls[0][0]).toBe('/api/policies/another-policy/review');
  });
});

describe('复核面板 — 谁能签字', () => {
  it('★非复核人：显示提示且**不渲染任何提交控件**', async () => {
    // 看得见 ≠ 能签字。策略拥有者若未被授予资格也在此列——
    // 防的是"自己写策略、自己签字确认"。
    // ★队列**必须非空**。上一版这里传的 body 没有 items，列表为空，
    //   于是"没有 accept 按钮"是因为根本没有条目可渲染 —— 断言过了，
    //   但过的理由是错的（变异验证发现：把 canReview 判断删掉，测试依然全绿）。
    stubFetch({ body: reviewBody({ canReview: false, subjectKind: null }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('notReviewer')).toBeDefined());
    // 先确认条目**确实渲染出来了**，再断言控件不在——
    // 否则又会退化成"空列表当合格"。
    expect(screen.getByText('10000')).toBeDefined();
    expect(screen.queryByText('accept')).toBeNull();
    expect(screen.queryByText('reject')).toBeNull();
    expect(screen.queryByLabelText('reasonLabel')).toBeNull();
  });

  it('复核人：渲染确认/拒绝按钮', async () => {
    stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());
    expect(screen.getByText('reject')).toBeDefined();
  });
});

describe('复核面板 — 提交约束', () => {
  it('★空理由必须被前端拦下，不发请求', async () => {
    // 服务端同样强制；前端这道只为即时反馈。两处都要——
    // 只有前端 = 可绕过；只有服务端 = 用户点了才知道。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    fetchFn.mockClear();
    fireEvent.click(screen.getByText('accept'));

    await waitFor(() => expect(screen.getByText('reasonRequired')).toBeDefined());
    // 只有加载用的 GET，不应有 POST
    const posts = fetchFn.mock.calls.filter((c) => (c[1] as { method?: string })?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('★错误提示必须渲染在**出错的那一条**里，而不是卡片底部', async () => {
    // 视觉验证发现的：错误原先挂在整张卡片末尾，队列一长就滚出视口，
    // 用户点了"确认"看起来像没反应。只断言"文案存在"的测试放过了它——
    // 所以这里断言的是**DOM 从属关系**。
    stubFetch({ body: reviewBody({ items: [item(), item({ nodeId: '$.b', text: '30 days' })] }) });
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('30 days')).toBeDefined());

    // 点**第二条**的确认（留空理由）
    fireEvent.click(screen.getAllByText('accept')[1]);

    const err = await screen.findByText('reasonRequired');
    const secondLi = screen.getByText('30 days').closest('li');
    expect(secondLi, '应能定位到第二个条目').not.toBeNull();
    expect(secondLi!.contains(err), '错误必须在第二条内部').toBe(true);

    // 且**不得**出现在第一条里——否则等于两条都报错
    const firstLi = screen.getByText('10000').closest('li');
    expect(firstLi!.contains(err)).toBe(false);
  });

  it('★填了理由后，请求体必须带 nodeId / contentHash / span', async () => {
    // 少任一样服务端都会拒（contentHash 还必须是 64 位十六进制）。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    fireEvent.change(screen.getByLabelText('reasonLabel'), {
      target: { value: '已与财务核对。' },
    });
    fireEvent.click(screen.getByText('accept'));

    await waitFor(() => {
      const post = fetchFn.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === 'POST',
      );
      expect(post, '应发出 POST').toBeDefined();
      const body = JSON.parse((post![1] as { body: string }).body) as Record<string, unknown>;
      expect(body.nodeId).toBe('$.a');
      expect(body.contentHash).toBe(HASH);
      expect(body.verdict).toBe('VERIFIED');
      expect(body.span).toEqual({ start: 37, end: 42 });
      expect(body.text).toBe('10000');
      // ★reason 必须逐字带过去。此前这条断言缺席，把 reason 截成 1 个字
      //   也能全绿——审计表里存的理由就成了"已"，原文丢失。
      expect(body.reason).toBe('已与财务核对。');
    });
  });

  it('★点**第二条**时，提交体必须整体属于第二条（防条目串线）', async () => {
    // ★所有解析 POST body 的用例此前都在**单条队列**上点 `[0]`，
    //   于是"被点的那一条"与"items[0]"在断言层面完全塌缩成同一个值。
    //   实测有 4 个独立缺陷同时隐身：
    //     nodeId/contentHash 取 items[0] → 复核人为**从未读过的条款**签字，
    //       而这张表 append-only、不可撤销；被点的那条则永远显示未复核
    //     verdict 非首条时发 VERIFIED → **点"拒绝"记成"通过"**
    //     reason 取 items[0] → 审计理由与条款错配，事后追溯失效
    //     span 取 items[0] → 被服务端自洽校验兜住，但用户只看到"提交失败"
    //   与 span 夹具那次同型：缺一个夹具维度，同时藏起多个缺陷。
    //   因此第二条的 nodeId / contentHash / text / span / reason **五项全异**。
    const second = {
      nodeId: '$.b', text: '30 days', span: { start: 80, end: 87 },
      contentHash: 'b'.repeat(64), reason: '第二条的机器理由',
    };
    const fetchFn = stubFetch({ body: reviewBody({ items: [item(), item(second)] }) });
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('30 days')).toBeDefined());

    const boxes = screen.getAllByLabelText('reasonLabel') as HTMLTextAreaElement[];
    fireEvent.change(boxes[0], { target: { value: '第一条的理由。' } });
    fireEvent.change(boxes[1], { target: { value: '第二条的理由。' } });
    fireEvent.click(screen.getAllByText('reject')[1]);        // 点第二条的「拒绝」

    await waitFor(() => {
      const post = fetchFn.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === 'POST',
      );
      expect(post, '应发出 POST').toBeDefined();
      const body = JSON.parse((post![1] as { body: string }).body) as Record<string, unknown>;
      // 整体断言：每一项都必须来自**第二条**
      expect(body.nodeId).toBe('$.b');
      expect(body.contentHash).toBe('b'.repeat(64));
      expect(body.text).toBe('30 days');
      expect(body.span).toEqual({ start: 80, end: 87 });
      expect(body.reason).toBe('第二条的理由。');
      expect(body.verdict, '点"拒绝"绝不能记成通过').toBe('REJECTED');
    });
  });

  it('点「拒绝」时 verdict 必须是 REJECTED', async () => {
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('reject')).toBeDefined());

    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: '不符合。' } });
    fireEvent.click(screen.getByText('reject'));

    await waitFor(() => {
      const post = fetchFn.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === 'POST',
      );
      const body = JSON.parse((post![1] as { body: string }).body) as Record<string, unknown>;
      expect(body.verdict).toBe('REJECTED');
    });
  });
});

describe('复核面板 — 提交失败与重复提交', () => {
  it('★服务端拒绝（403）时必须报错，且**不得**表现得像成功', async () => {
    // 这是整组测试里生产后果最重的一条：
    //   若失败分支被吞掉，界面会清空理由框并刷新——**和成功一模一样**。
    //   复核人确信自己签了字，而 Proof 从未落库。
    //   对一个证据链产品来说，没有比这更坏的失败方式。
    const fetchFn = stubFetch({ postStatus: 403 });
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    const box = screen.getByLabelText('reasonLabel') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '已与财务核对。' } });
    fireEvent.click(screen.getByText('accept'));

    // ① 必须显示失败
    const err = await screen.findByText('submitFailed');
    expect(screen.getByText('10000').closest('li')!.contains(err)).toBe(true);
    // ② 理由**不得**被清空——清空等于让人以为提交成功了
    expect(box.value).toBe('已与财务核对。');
    // ③ 不得重新拉取（重新拉取是成功路径的动作）
    const gets = fetchFn.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method !== 'POST',
    );
    expect(gets).toHaveLength(1);
  });

  it('★连点两次只能提交一次 —— 表是 append-only，重复即污染审计', async () => {
    // 重复提交 = 审计表里两条永久 Proof；若先点"拒绝"再点"确认"，
    // 最终有效结论取决于哪个响应先回来——非确定性。
    //
    // 生产代码有两道守卫：`disabled={busyNode===…}`（异步 state）
    // 与 `inFlight`（同步 ref）。本用例用原生派发**精确锁住后者**——
    // 只删 inFlight 即变红，只删 disabled 不变红（后者另由 UI 用例覆盖）。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: '核对无误。' } });
    const btn = screen.getByText('accept');

    // ★用**原生 dispatchEvent**，不走 fireEvent。
    //   fireEvent（以及手工 act 包裹）会被 RTL 的 act 批处理保护：
    //   两次点击之间 state 恰好来得及刷新，于是 `disabled` 这道异步守卫
    //   就足以挡住第二次——同步守卫删掉也不会变红（实测确认）。
    //   原生派发绕开这层保护，才能真正隔离出 `inFlight`。
    const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(click());
    btn.dispatchEvent(click());

    await waitFor(() => {
      const posts = fetchFn.mock.calls.filter(
        (c) => (c[1] as { method?: string })?.method === 'POST',
      );
      expect(posts, '只能发出一次 POST').toHaveLength(1);
    });
  });
});

  it('★提交成功后必须清空理由框**并**重新拉取', async () => {
    // 不清空 → 用户以为没提交出去，容易重复签；
    // 不重新拉取 → 刚签的结论不出现在界面上，同样像是失败了。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    const box = screen.getByLabelText('reasonLabel') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '核对无误。' } });
    fireEvent.click(screen.getByText('accept'));

    await waitFor(() => expect(box.value).toBe(''));
    const gets = fetchFn.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method !== 'POST',
    );
    expect(gets.length, '成功后必须重新拉取一次').toBe(2);
  });

describe('复核面板 — 队列外结论的可见性', () => {
  it('★队列**非空**时，队列外节点的结论仍必须可见', async () => {
    // 之前的渲染条件是 `items.length === 0 && …`，于是只要队列里还有一条待办，
    // 所有"机器已证明"和"已被拒绝"的节点的结论就整片消失——
    // 而这两类恰恰不会进队列，是最常见的情况。
    stubFetch({
      body: reviewBody({
        items: [item()],                       // 队列里是 $.a
        // ★两条**不同 nodeId** 的队列外结论，字段全异。
        proofs: [
          { id: 'x', nodeId: '$.other', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
            reason: '口径不符', subjectKind: 'engineer', subjectUserId: 'carol',
            text: '90 days', span: { start: 0, end: 7 },
            recordedAt: '2026-09-11T00:00:00Z' },
          { id: 'y', nodeId: '$.third', contentHash: 'f'.repeat(64), verdict: 'VERIFIED',
            reason: '已核对', subjectKind: 'domain_expert', subjectUserId: 'dave',
            text: '60 days', span: { start: 10, end: 17 },
            recordedAt: '2026-09-10T00:00:00Z' },
        ],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('10000')).toBeDefined());  // 队列条目在
    expect(screen.getByText('recordedTitle'), '队列外结论区必须存在').toBeDefined();
    // ★逐 <li> 断言从属关系。整卡片 getByText 在**单条**队列外结论下
    //   无法区分"逐行渲染"与"全取第一行"——把 verdict/记录人/理由
    //   串成 recordedProofs[0] 的值也照样绿，而那正是本用例注释里
    //   描述的危害（一条已被拒绝的结论显示成"已通过"）。
    const liCarol = screen.getByText('90 days').closest('li')!;
    expect(liCarol.textContent).toContain('carol');
    expect(liCarol.textContent).toContain('REJECTED');
    expect(liCarol.textContent).toContain('口径不符');
    expect(liCarol.textContent, '不得串到另一条的记录人').not.toContain('dave');

    const liDave = screen.getByText('60 days').closest('li')!;
    expect(liDave.textContent).toContain('dave');
    expect(liDave.textContent).toContain('VERIFIED');
    expect(liDave.textContent).toContain('已核对');
    expect(liDave.textContent).not.toContain('carol');
    // ★verdict 与 reason 必须逐字断言。条目**内部**那份渲染已被锁住，
    //   但队列外这份是独立的第二条渲染路径——把 verdict 写死成 VERIFIED
    //   会让一条**已被拒绝**的结论显示成"已通过"，是本面板最直接的误导。
    expect(screen.getByText(/REJECTED/)).toBeDefined();
    expect(screen.getByText('口径不符')).toBeDefined();
  });

  it('★同一节点有多条结论时，必须标注"已被覆盖"', async () => {
    // 撤销＝追加一条新 Proof，旧的仍留在表里。不标注的话，读者会以为
    // 当前这条从一开始就是这样——而它其实是修订后的判断。
    const mk = (id: string, verdict: string) => ({
      id, nodeId: '$.other', contentHash: 'b'.repeat(64), verdict,
      reason: `理由-${id}`, subjectKind: 'engineer', subjectUserId: 'carol',
      text: '90 days', span: { start: 0, end: 7 }, recordedAt: '2026-09-11T00:00:00Z',
    });
    stubFetch({ body: reviewBody({ items: [item()], proofs: [mk('n', 'REJECTED'), mk('o', 'VERIFIED')] }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('recordedTitle')).toBeDefined());
    expect(screen.getByText('supersededNote')).toBeDefined();
  });

  it('★只有一条结论时**不得**标注"已被覆盖"', async () => {
    // 反向守卫：否则每条结论都挂这句提示，等于没说。
    stubFetch({
      body: reviewBody({ items: [item()], proofs: [{
        id: 'solo', nodeId: '$.other', contentHash: 'b'.repeat(64), verdict: 'VERIFIED',
        reason: '唯一结论', subjectKind: 'engineer', subjectUserId: 'carol',
        text: '90 days', span: { start: 0, end: 7 }, recordedAt: '2026-09-11T00:00:00Z',
      }] }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('recordedTitle')).toBeDefined());
    expect(screen.queryByText('supersededNote')).toBeNull();
  });

  it('队列内节点的结论**不**在队列外区域重复渲染', async () => {
    // 反向守卫：别把上一条改成"所有结论都再列一遍"——同一条结论
    // 出现两次会让人以为签了两次。
    stubFetch({
      body: reviewBody({
        items: [item()],                       // $.a
        proofs: [{
          id: 'y', nodeId: '$.a', contentHash: HASH, verdict: 'VERIFIED',
          reason: '已确认', subjectKind: 'domain_expert', subjectUserId: 'dave',
          text: '10000', span: { start: 0, end: 5 },
          recordedAt: '2026-09-11T00:00:00Z',
        }],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('10000')).toBeDefined());
    // 结论画在条目内部即可，不该另起一个"队列外"区块
    expect(screen.queryByText('recordedTitle')).toBeNull();
    expect(screen.getAllByText(/dave/)).toHaveLength(1);
  });

  it('★contentHash 非十六进制（长度合格）不得进队列', async () => {
    // `'z'.repeat(64)` 长度 64 但不是十六进制：只查长度会放行，
    // 用户点下去才被 POST 的 /^[0-9a-f]{64}$/ 以 400 拒绝。
    stubFetch({ body: reviewBody({ items: [item({ contentHash: 'z'.repeat(64) })] }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('empty')).toBeDefined());
    expect(screen.queryByText('accept')).toBeNull();
  });
});

  it('★服务端 500 必须显示加载失败，不得静默变成"没有待复核项"', async () => {
    // 500 若被静默降级，界面显示 0/0/0 + "没有待复核项"——
    // 与"一切正常且无待办"视觉上完全一致。这是 fail-open 的另一个入口：
    // 前面堵的是 queueStatus，这里堵的是 HTTP 层。
    stubFetch({ status: 500 });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('loadFailed')).toBeDefined());
    expect(screen.queryByText('empty'), '不得同时说"没有待复核项"').toBeNull();
  });

  it('★条目只显示**自己那个 nodeId** 的结论，不得张冠李戴', async () => {
    // 之前所有 fixture 里 item 和 proof 的 nodeId 都是同一个，
    // "按 nodeId 取"和"随便取一条"不可区分。
    // 真出错时的后果是：条款 A 的界面上显示条款 B 的"已拒绝"。
    // ★队列必须**两条**：单条时 `items[0].nodeId === item.nodeId` 恒成立，
    //   把 effective 改成按 `items[0].nodeId` 取也不可区分——
    //   而那意味着第二条起都显示第一条的已有结论。
    stubFetch({
      body: reviewBody({
        items: [item(), item({ nodeId: '$.b', text: '30 days',
                               span: { start: 80, end: 87 }, contentHash: 'b'.repeat(64) })],
        proofs: [{
          id: 'z', nodeId: '$.b', contentHash: 'b'.repeat(64), verdict: 'REJECTED',
          reason: '第二条的结论', subjectKind: 'engineer', subjectUserId: 'erin',
          text: '30 days', span: { start: 80, end: 87 },
          recordedAt: '2026-09-11T00:00:00Z',
        }],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('10000')).toBeDefined());
    const li = screen.getByText('10000').closest('li')!;
    expect(li.textContent, '$.a 的条目内不得出现 $.b 的记录人').not.toContain('erin');
    expect(li.textContent).not.toContain('recordedBy');
    // 反向：$.b 自己那条**必须**显示它的结论，否则上面的断言可能只是"全都不显示"。
    const liB = screen.getByText('30 days').closest('li')!;
    expect(liB.textContent, '$.b 必须显示自己的结论').toContain('erin');
  });

  it('提交进行中按钮必须禁用并显示 submitting（锁住另一道守卫）', async () => {
    // 与上一条配对：上一条用原生派发锁 `inFlight`，这一条锁 `disabled`。
    // 两道守卫各有各的用例，删任意一道都会有测试变红。
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => { release = r; });
    const fn = vi.fn().mockImplementation((_u: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return pending;
      return Promise.resolve({ ok: true, status: 200, json: async () => reviewBody() });
    });
    vi.stubGlobal('fetch', fn);

    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());
    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: '核对无误。' } });
    fireEvent.click(screen.getByText('accept'));

    // POST 尚未返回：按钮应处于禁用 + submitting 文案
    const btn = await screen.findByText('submitting');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('reject').closest('button')!.disabled).toBe(true);

    release({ ok: true, status: 200, json: async () => ({ recorded: true }) });
  });

  it('★canReview 为**真值但不是 true** 时同样不得渲染提交控件', async () => {
    // ★缺字段那条用例挡不住这个：`undefined` 对严格相等和真值判断
    //   都是 falsy，两种写法在该输入上**不可区分**。
    //   必须喂一个真值但非 true 的值（旧服务端、字段改名、部分失败
    //   都可能返回这类值），才能真正钉住 `=== true`。
    stubFetch({ body: reviewBody({ canReview: 'yes' as unknown as boolean }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('10000')).toBeDefined());
    expect(screen.queryByText('accept'), '非严格 true 不得给出签字入口').toBeNull();
    expect(screen.queryByText('reject')).toBeNull();
  });

  it('★响应缺 canReview 字段时不得渲染提交控件（默认不能签）', async () => {
    // 真值判断会让缺字段等价于"能签"。默认必须是"不能签"。
    stubFetch({ body: { items: [item()], counts: { verified: 0, reviewRequired: 1, rejected: 0 },
                        queueStatus: 'ok', subjectKind: null, proofs: [] } });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('10000')).toBeDefined());
    expect(screen.queryByText('accept')).toBeNull();
    expect(screen.queryByText('reject')).toBeNull();
  });

  it('★提交一条后，**其他条目的草稿不得被清空**', async () => {
    // 队列里 5 条待办、理由都打好了，提交第 1 条后另外 4 条全消失——
    // 这是实打实的工作丢失。
    // ★本用例必须放**两条**：单条队列下"只清空提交的那条"与"清空全部"
    //   不可区分——草稿隔离缺陷正是这样躲过去的。
    stubFetch({ body: reviewBody({
      items: [item(), item({ nodeId: '$.b', text: '30 days',
                             span: { start: 80, end: 87 } })],
    }) });
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('30 days')).toBeDefined());

    const boxes = screen.getAllByLabelText('reasonLabel') as HTMLTextAreaElement[];
    fireEvent.change(boxes[0], { target: { value: '第一条的理由。' } });
    fireEvent.change(boxes[1], { target: { value: '第二条的理由。' } });
    fireEvent.click(screen.getAllByText('accept')[0]);

    await waitFor(() => expect(boxes[0].value).toBe(''));   // 提交的那条清空
    expect(boxes[1].value, '其他条目的草稿必须保留').toBe('第二条的理由。');
  });

  it('★纯空白理由必须被前端拦下', async () => {
    // 不 trim 的话空白串是 truthy，会被发去服务端再被 400 打回。
    const fetchFn = stubFetch({});
    render(<PolicyReviewPanel policyId="p1" />);
    await waitFor(() => expect(screen.getByText('accept')).toBeDefined());

    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: '    ' } });
    fetchFn.mockClear();
    fireEvent.click(screen.getByText('accept'));

    await waitFor(() => expect(screen.getByText('reasonRequired')).toBeDefined());
    expect(fetchFn.mock.calls.filter(
      (c) => (c[1] as { method?: string })?.method === 'POST')).toHaveLength(0);
  });

describe('复核面板 — 有效结论与时效性', () => {
  /** 同一节点的两条结论：旧 VERIFIED，新 REJECTED。 */
  function twoProofs(newHash: string) {
    return [
      { id: 'new', nodeId: '$.a', contentHash: newHash, verdict: 'REJECTED',
        reason: '复议后拒绝', subjectKind: 'domain_expert', subjectUserId: 'bob',
        text: '10000', span: { start: 0, end: 5 }, recordedAt: '2026-09-12T00:00:00Z' },
      { id: 'old', nodeId: '$.a', contentHash: HASH, verdict: 'VERIFIED',
        reason: '当初确认', subjectKind: 'domain_expert', subjectUserId: 'alice',
        text: '10000', span: { start: 0, end: 5 }, recordedAt: '2026-09-10T00:00:00Z' },
    ];
  }

  it('★同节点多条结论时，取**最新**那条（服务端按 createdAt desc 返回）', async () => {
    // 此前所有 fixture 都只放一条 proof——"取第一条"和"取最后一条"
    // 在单元素下不可区分，于是 effectiveByNode 的去重守卫改坏了也全绿。
    stubFetch({ body: reviewBody({ proofs: twoProofs(HASH) }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText(/bob/)).toBeDefined());
    expect(screen.getByText(/REJECTED/), '应显示最新的 REJECTED').toBeDefined();
    expect(screen.queryByText(/alice/), '不得显示被覆盖的旧结论').toBeNull();
  });

  it('★stale 必须按**每条自己**的 contentHash 判定，不得用 items[0] 的', async () => {
    // ★双条目队列，且两条的 stale 状态**相反**：
    //   $.a 的 proof hash 与候选不同 → 应标注；
    //   $.b 的 proof hash 与候选相同 → 不应标注。
    //   单条队列下 `items[0].contentHash === item.contentHash` 恒成立，
    //   把判据换成 items[0] 完全不可区分——而那会让真正内容已变的条目
    //   **不**提示（复核人不知道自己在为已变更的文本背书），未变的反而提示。
    stubFetch({
      body: reviewBody({
        items: [item(), item({ nodeId: '$.b', text: '30 days',
                               span: { start: 80, end: 87 }, contentHash: 'b'.repeat(64) })],
        proofs: [
          { id: 'pa', nodeId: '$.a', contentHash: 'd'.repeat(64), verdict: 'VERIFIED',
            reason: '对旧内容作出', subjectKind: 'domain_expert', subjectUserId: 'bob',
            text: '10000', span: { start: 37, end: 42 },
            recordedAt: '2026-09-12T00:00:00Z' },
          { id: 'pb', nodeId: '$.b', contentHash: 'b'.repeat(64), verdict: 'VERIFIED',
            reason: '内容未变', subjectKind: 'domain_expert', subjectUserId: 'carol',
            text: '30 days', span: { start: 80, end: 87 },
            recordedAt: '2026-09-12T00:00:00Z' },
        ],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('30 days')).toBeDefined());
    const liA = screen.getByText('10000').closest('li')!;
    const liB = screen.getByText('30 days').closest('li')!;
    expect(liA.textContent, '$.a 内容已变，必须标注').toContain('staleNote');
    expect(liB.textContent, '$.b 内容未变，不得标注').not.toContain('staleNote');
  });

  it('★内容未变更时**不得**标注 staleNote —— 否则等于永远报警', async () => {
    // 反向守卫：把 stale 判定写死成 true 也要能被抓住。
    stubFetch({ body: reviewBody({ proofs: twoProofs(HASH) }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText(/bob/)).toBeDefined());
    expect(screen.queryByText(/staleNote/)).toBeNull();
  });
});

describe('复核面板 — 候选过滤与降级', () => {
  it('★缺 contentHash 的候选不得进队列', async () => {
    // 服务端要求 64 位十六进制；渲染出来只会让人点了才发现签不了。
    stubFetch({ body: reviewBody({ items: [item({ contentHash: undefined })] }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('title')).toBeDefined());
    expect(screen.getByText('empty')).toBeDefined();
    expect(screen.queryByText('accept')).toBeNull();
  });

  it('★contentHash 长度不对同样不得进队列', async () => {
    stubFetch({ body: reviewBody({ items: [item({ contentHash: 'abc' })] }) });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('empty')).toBeDefined());
  });

  it('★服务端算不出队列时面板仍在 —— 已落库的结论仍有价值', async () => {
    // 引擎跑不起来（或版本过旧无 runSemanticBridge）时，路由 catch 住并返回
    // 空队列。面板必须降级为"只看结论"，而不是整块消失。
    stubFetch({
      body: reviewBody({
        items: [],
        counts: { verified: 0, reviewRequired: 0, rejected: 0 },
        proofs: [{
          id: 'pr1', nodeId: '$.a', contentHash: HASH, verdict: 'VERIFIED',
          reason: '已核对', subjectKind: 'domain_expert', subjectUserId: 'alice',
          text: '10000', span: { start: 0, end: 5 }, recordedAt: '2026-09-14T00:00:00Z',
        }],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('title')).toBeDefined());
    expect(screen.getByText('empty')).toBeDefined();
    // ★必须断言结论**内容真的渲染出来了**，不能只验"面板还在"。
    //   队列为空正是**当前生产的唯一路径**（pin 的引擎无 runSemanticBridge），
    //   所以这条用例守的就是线上每天走的那条路。只断言 title/empty 的话，
    //   把 recordedProofs 在队列为空时返回 [] 也照样全绿——
    //   而那意味着线上所有已落库结论一条都不显示。
    expect(screen.getByText('recordedTitle')).toBeDefined();
    expect(screen.getByText(/alice/)).toBeDefined();
    expect(screen.getByText(/VERIFIED/)).toBeDefined();
    expect(screen.getByText('已核对')).toBeDefined();
  });

  it('★引擎不可用时必须说"不可用"，不得显示成"没有待复核项"', async () => {
    // 这是本组件最危险的 fail-open：队列算不出来时如果显示"没有待复核项"，
    // 审计员会以为"机器都证明完了"——而机器**根本没跑**。
    // "空"是一个结论；"不可用"是**没有结论**。两者必须可区分。
    stubFetch({
      body: reviewBody({ items: [], queueStatus: 'engine_error',
                         counts: { verified: 0, reviewRequired: 0, rejected: 0 } }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('queueUnavailable')).toBeDefined());
    expect(screen.queryByText('empty'), '不得同时显示"没有待复核项"').toBeNull();
  });

  it('队列正常且确实为空时，显示"没有待复核项"而非"不可用"', async () => {
    // 反向守卫：别把上一条修成"永远报不可用"。
    stubFetch({
      body: reviewBody({ items: [], queueStatus: 'ok',
                         counts: { verified: 3, reviewRequired: 0, rejected: 0 } }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('empty')).toBeDefined());
    expect(screen.queryByText('queueUnavailable')).toBeNull();
  });

  it('★items 字段缺失（旧版服务端）不得崩溃，且**按不可用处理**', async () => {
    // 契约演进的容错：老服务端不返回 items/counts/queueStatus。
    // ★注意它显示的是"不可用"而非"没有待复核项"——这是**故意**的：
    //   老服务端根本没跑过引擎，队列状态就是"未知"。
    //   把未知说成"空"，就是在替一个没发生过的检查背书。
    stubFetch({ body: { canReview: true, subjectKind: 'domain_expert', proofs: [] } });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText('title')).toBeDefined());
    expect(screen.getByText('queueUnavailable')).toBeDefined();
    expect(screen.queryByText('empty')).toBeNull();
    // ★必须断言**没有** loadFailed。只断 title/empty 是不够的：
    //   load() 的 catch 会把 `undefined.filter` 的 TypeError 一并吞掉、
    //   照样 setVisible(true)，于是 title/empty 仍然渲染 —— 测试绿，
    //   但绿的理由是"崩了之后进了错误分支"，不是"优雅兜底"。
    //   （变异验证：去掉 `?? []` 时，只有这一条断言能变红。）
    expect(screen.queryByText('loadFailed')).toBeNull();
    // 能签字的控件也应正常在位——真崩了的话 canReview 状态就丢了。
    expect(screen.getByText('reviewRequired: 0')).toBeDefined();
  });

  it('已有结论时展示记录人与结论', async () => {
    stubFetch({
      body: reviewBody({
        proofs: [{
          id: 'pr1', nodeId: '$.a', contentHash: HASH, verdict: 'VERIFIED',
          reason: '已核对', subjectKind: 'domain_expert', subjectUserId: 'alice',
          text: '10000', span: { start: 0, end: 5 }, recordedAt: '2026-09-14T00:00:00Z',
        }],
      }),
    });
    render(<PolicyReviewPanel policyId="p1" />);

    await waitFor(() => expect(screen.getByText(/alice/)).toBeDefined());
  });
});
