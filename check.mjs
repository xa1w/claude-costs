// One check: 1M of each token kind on Opus 5.5 = 4 + 20 + 0.2 + 5(5m write) + 8(1h write) = 37.2
process.env.PORT = 0;
const { cost } = await import('./server.mjs');
const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } };
const c = cost('claude-opus-5-5', u);
if (Math.abs(c - 37.2) > 1e-9) throw new Error('got ' + c);
if (cost('seedance_2_5', u) !== 0) throw new Error('unpriced model should be 0');
console.log('ok', c); process.exit(0);
