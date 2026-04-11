import mongoose from 'mongoose';

await mongoose.connect('mongodb://127.0.0.1:27017/lanagent');
const db = mongoose.connection.db;

// Check CryptoWallet - get addresses (NOT the seed)
const wallets = await db.collection('cryptowallets').find({}).toArray();
console.log('=== Crypto Wallets ===');
for (const w of wallets) {
  console.log('  Created:', w.createdAt);
  console.log('  Has encrypted seed:', !!w.encryptedSeed);
  if (w.addresses) {
    for (const addr of w.addresses) {
      console.log(`  ${addr.chain}: ${addr.address}`);
    }
  }
}

// Check crypto strategy state more thoroughly
const stratDoc = await db.collection('cryptostrategies').findOne({});
if (stratDoc?.strategyRegistry) {
  const reg = stratDoc.strategyRegistry;
  console.log('\n=== Strategy Registry ===');
  console.log('Active:', reg.activeStrategy);
  for (const [name, state] of Object.entries(reg.strategies || {})) {
    console.log(`\n  Strategy: ${name}`);
    console.log('    enabled:', state.enabled);
    if (state.config) console.log('    config:', JSON.stringify(state.config));
    if (state.state) console.log('    state:', JSON.stringify(state.state));
  }
}

// Check LP positions
const lp = await db.collection('lppositions').find({}).toArray();
console.log('\n=== LP Positions ===');
console.log('Count:', lp.length);
for (const p of lp) {
  console.log(JSON.stringify(p, null, 2));
}

await mongoose.disconnect();
