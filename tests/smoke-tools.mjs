// 用假 ctx 验证：apply() 能在 ctx.inject(['tools'], ...) 回调里把 4 个工具注册上。
const calls = [];
const registry = { register(def) { calls.push(def); return () => {}; } };

const ctx = {
  inject(names, callback) {
    const injected = { effect: (fn) => fn() };
    for (const name of names) injected[name] = name === 'tools' ? registry : undefined;
    callback(injected);
  },
};

const mod = await import('../lib/index.js');
mod.apply(ctx, {});
console.log('exports:', Object.keys(mod).sort().join(','));
console.log('registered:', calls.map((c) => c.name).join(','));
console.log('first def keys:', Object.keys(calls[0]).join(','));
console.log('params:', JSON.stringify(calls[0].parameters));
console.log('render:', JSON.stringify(calls[0].output.render({}, { ok: true })));
