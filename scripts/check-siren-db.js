// SIREN Token Trader - Full DB state snapshot
import mongoose from 'mongoose';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent');
  const db = mongoose.connection.db;

  // State is stored at state.domainState.strategyRegistry (via BaseAgentHandler.updateState)
  // Look in subagents collection
  const collections = (await db.listCollections().toArray()).map(c => c.name).sort();

  // Find the CryptoStrategyAgent document
  let tokenTraderState = null;
  let agentDoc = null;

  for (const collName of collections) {
    if (/agent|subagent/i.test(collName)) {
      const docs = await db.collection(collName).find({}).toArray();
      for (const doc of docs) {
        const reg = doc.state?.domainState?.strategyRegistry;
        if (reg?.token_trader) {
          tokenTraderState = reg.token_trader;
          agentDoc = doc;
          console.log(`Found token_trader in collection "${collName}", doc: ${doc.name || doc.type || doc._id}`);
          break;
        }
      }
      if (tokenTraderState) break;
    }
  }

  if (!tokenTraderState) {
    // Check subagents specifically
    const subagents = await db.collection('subagents').find({}).toArray();
    console.log(`\nSubagents: ${subagents.length} docs`);
    for (const sa of subagents) {
      console.log(`  - ${sa.name || sa.type || '?'} (keys: ${Object.keys(sa.state || {}).join(', ')})`);
      const ds = sa.state?.domainState;
      if (ds) {
        console.log(`    domainState keys: ${Object.keys(ds).join(', ')}`);
        if (ds.strategyRegistry) {
          const reg = ds.strategyRegistry;
          console.log(`    strategyRegistry keys: ${Object.keys(reg).join(', ')}`);
          console.log(`    activeStrategy: ${reg.activeStrategy}`);
          console.log(`    secondaryStrategy: ${reg.secondaryStrategy}`);
          if (reg.strategies) {
            console.log(`    strategies keys: ${Object.keys(reg.strategies).join(', ')}`);
            // token_trader is inside strategies
            if (reg.strategies.token_trader) {
              tokenTraderState = reg.strategies.token_trader;
              agentDoc = sa;
              console.log('    >>> FOUND token_trader in strategies!');
            }
          }
          // Also check direct key
          if (reg.token_trader) {
            tokenTraderState = reg.token_trader;
            agentDoc = sa;
            console.log('    >>> FOUND token_trader at top level!');
          }
        }
        // Also check tokenTraderStatus
        if (ds.tokenTraderStatus) {
          console.log(`    tokenTraderStatus keys: ${Object.keys(ds.tokenTraderStatus).join(', ')}`);
        }
      }
    }
  }

  if (!tokenTraderState) {
    // Broader search across all collections
    for (const collName of ['subagents', 'agents', 'cryptostrategies', 'pluginsettings', 'systemsettings']) {
      const sample = await db.collection(collName).findOne({
        $or: [
          { 'state.domainState.strategyRegistry.token_trader': { $exists: true } },
          { 'strategyRegistry.token_trader': { $exists: true } },
          { 'config.token_trader': { $exists: true } },
          { 'value.strategyRegistry.token_trader': { $exists: true } }
        ]
      });
      if (sample) {
        const tt = sample.state?.domainState?.strategyRegistry?.token_trader
          || sample.strategyRegistry?.token_trader
          || sample.config?.token_trader
          || sample.value?.strategyRegistry?.token_trader;
        if (tt) {
          tokenTraderState = tt;
          agentDoc = sample;
          console.log(`Found token_trader in "${collName}" via broad query`);
          break;
        }
      }
    }
  }

  if (tokenTraderState) {
    console.log('\n=== Token Trader Persisted State ===');
    console.log(JSON.stringify(tokenTraderState, null, 2));
  } else {
    console.log('WARNING: token_trader state NOT found!');
    console.log('Collections:', collections.join(', '));
  }

  // Trade journal
  if (tokenTraderState?.journal?.length > 0) {
    const journal = tokenTraderState.journal;
    console.log(`\n=== Trade Journal (${journal.length} entries, showing last 20) ===`);
    for (const j of journal.slice(-20)) {
      console.log(`  ${j.timestamp} ${j.action} ${j.amount || ''} @${j.price || ''} ${j.reason || ''}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
