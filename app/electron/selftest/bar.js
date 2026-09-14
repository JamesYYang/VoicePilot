/**
 * 悬浮条窗口几何自测。
 *
 * 用法：cd app && VP_BAR_SELFTEST=1 npx electron .
 *
 * **需要真实显示器**（与其它自测不同）：这里量的就是真窗口在真屏幕上的坐标与尺寸。
 * 无头环境跑不了，所以它不进「无人值守」那一组。
 *
 * 存在的理由：两条真机反馈都只在**真窗口 + 真屏幕缩放**下复现，界面自测
 * （900×700 的隐藏窗口，且 resizeBar 是空实现）在结构上就看不见它们：
 *
 * 1. **底边漂移**（用户反馈：悬浮条有时候被 Windows 任务栏遮挡）。窗口高度归主进程所有，
 *    而 resizeBar/resetBarHeight 都从「上一次的 bounds」推新位置；缩放不是 100% 时
 *    系统会把高度取整（1.5 倍下 153 → 154），于是每次缩放/复位都把底边往下推 1px，
 *    几十次之后底边就压进了任务栏。真机实测：40 次 resize 后底边从 1208 漂到 1247。
 * 2. **第二次打开选择器长不高**（用户反馈：常用语高度不够，只能看到第一条）。渲染侧把
 *    「上次请求过的值」当基准去做去重，而主进程会在 idle/warming 用 resetBarHeight
 *    把窗口收回基础高度 —— 那是渲染侧看不见的变化。第二次打开时算出来的值仍与上次相同，
 *    这次 resize 就被当成「没变化」吞掉，窗口留在 148，列表只剩一行可见。
 *    真机实测：请求 368 被吞，rootClient=131 而 rootScroll=350。
 *
 * 两条都靠**几何事实**断言（底边贴着工作区右下角、内容没被裁），不靠内部实现细节。
 */
export async function runBarSelftest({ getBar, resizeBar, resetBarHeight, machine, screen, BAR }) {
  console.log('[自测] 悬浮条窗口几何（bar）');
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: Boolean(cond), detail });
    console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = getBar();
  if (!bar || bar.isDestroyed()) {
    check('悬浮条窗口已创建', false);
    return summarize(results);
  }

  // 等渲染进程加载并挂载完（挂载后才会订阅 vp:state，发早了选择器不渲染）。
  if (bar.webContents.isLoading()) {
    await new Promise((r) => bar.webContents.once('did-finish-load', r));
  }
  await sleep(1500);

  const wa = screen.getPrimaryDisplay().workArea;
  // 悬浮条该在的位置：贴着工作区右下角留一个 margin。**每次都由工作区重新推**，
  // 这是本次修复的核心 —— 断言也正是「有没有做到」。
  const expectX = wa.x + wa.width - BAR.width - BAR.margin;
  const expectBottom = wa.y + wa.height - BAR.margin;
  // 取整容差：非 100% 缩放下系统会把窗口矩形对到物理像素上，回读值可能与请求差 1px。
  const TOL = 1;
  const bounds = () => bar.getBounds();
  const atAnchor = () =>
    Math.abs(bounds().x - expectX) <= TOL && Math.abs(bounds().y + bounds().height - expectBottom) <= TOL;

  check('起始就贴着工作区右下角', atAnchor(),
    `bounds=${JSON.stringify(bounds())} 期望 x=${expectX} bottom=${expectBottom}`);

  // ---- 1. 反复缩放/复位之后底边不得漂移 ----
  // 高度用**奇数**：非 100% 缩放（1.25 / 1.5 / 1.75）下奇数高会落在物理像素之间，
  // 系统取整后回读值比请求值大 1 —— 旧实现（从上次 bounds 推位置）就是在这一步被顶下去的。
  // 偶数高在 1.5 倍下取整无损，用它做样本反倒盖不住这个 bug。
  for (let i = 0; i < 30; i++) {
    resizeBar(i % 2 === 0 ? 201 : 333);
  }
  resetBarHeight();
  check('30 轮 resize + reset 之后底边仍贴着工作区右下角',
    atAnchor(),
    `bounds=${JSON.stringify(bounds())} 期望 x=${expectX} bottom=${expectBottom}`);

  // 复位后必须回到基础高度（旧实现这里也会漂）
  check('复位后窗口高度回到基础高度',
    Math.abs(bounds().height - BAR.height) <= TOL,
    `height=${bounds().height} 期望=${BAR.height}`);

  // ---- 2. 每次打开常用语选择器都要有合身的高度 ----
  // 判据用**几何事实**：内容没被裁（根节点的 scrollHeight 不超过 clientHeight）。
  // 用列表自己的 scrollHeight 判不出来 —— 列表是 flexShrink:0，窗口不够高时它自己
  // 不被裁，被裁的是外层根节点，看列表的数值永远是「装得下」。
  const probe = async () => {
    const s = await bar.webContents.executeJavaScript(
      `(() => {
         const root = document.querySelector('[data-state]');
         const list = document.querySelector('[data-testid="phrase-list"]');
         return JSON.stringify({
           rootScroll: root ? root.scrollHeight : null,
           rootClient: root ? root.clientHeight : null,
           items: document.querySelectorAll('[data-testid="phrase-item"]').length,
           hasList: list != null,
         });
       })()`
    );
    return JSON.parse(s);
  };

  for (let round = 1; round <= 2; round++) {
    const opened = await machine.openPhrases();
    await sleep(1200);
    const m = await probe();
    check(`第 ${round} 次打开选择器：选择器已渲染`, m.hasList && opened?.ok === true,
      JSON.stringify({ m, opened }));
    check(`第 ${round} 次打开选择器：窗口长到内容需要的高度`, bounds().height > BAR.height,
      `height=${bounds().height}`);
    check(`第 ${round} 次打开选择器：内容没有被窗口裁掉（能看到全部条目）`,
      m.rootScroll != null && m.rootClient != null && m.rootScroll <= m.rootClient + TOL,
      `rootScroll=${m.rootScroll} rootClient=${m.rootClient} items=${m.items}`);
    check(`第 ${round} 次打开选择器：仍然贴着工作区右下角`, atAnchor(),
      JSON.stringify(bounds()));

    await machine.openPhrases(); // 再按一次 = 关闭选择器
    await sleep(800);
    check(`第 ${round} 次关闭选择器：窗口收回基础高度`,
      Math.abs(bounds().height - BAR.height) <= TOL, `height=${bounds().height}`);
    check(`第 ${round} 次关闭选择器：仍贴着工作区右下角`, atAnchor(),
      JSON.stringify(bounds()));
  }

  // ---- 3. 条不再渲染时必须恢复穿透（真机反馈：Mac 上 Chrome 右下角的按钮点不动）----
  // 条是常驻置顶窗口，占着屏幕右下角 560×148。鼠标移入时它会临时关掉穿透（条里的按钮
  // 才点得到），而「移出」是在渲染侧的根节点上收的 —— 条一回到 idle 就不再渲染、元素被
  // 卸载，那个 mouseleave 永远不会来，穿透就停在「关」上：窗口看不见、却一直吃掉那块
  // 矩形里的点击。这里量的是**窗口真实收到的那次 setIgnoreMouseEvents**，不是渲染侧意图。
  const passthrough = []; // 记录 setIgnoreMouseEvents 的实参：true=穿透（点得下去）
  const origSetIgnore = bar.setIgnoreMouseEvents.bind(bar);
  bar.setIgnoreMouseEvents = (ignore, opts) => {
    passthrough.push(Boolean(ignore));
    return origSetIgnore(ignore, opts);
  };

  await machine.openPhrases();
  await sleep(1200);
  await bar.webContents.executeJavaScript(
    `(() => {
       const root = document.querySelector('[data-state]');
       if (root) root.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(300);
  check('鼠标移入条时关掉穿透（条里的按钮才点得到）',
    passthrough[passthrough.length - 1] === false, JSON.stringify(passthrough));

  await machine.openPhrases(); // 关掉选择器 → 条不再渲染
  await sleep(800);
  check('条不再渲染后必须恢复穿透（否则不可见的窗口会吃掉屏幕右下角的点击）',
    passthrough[passthrough.length - 1] === true, JSON.stringify(passthrough));

  return summarize(results);
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
