import {messageGrowthFixtures} from './presentation-message-growth-fixtures';

/** Release gate invokes each registered reader's real bounded read against growth fixtures.
 * Session-card fixtures are registered independently by their owner. */
export const READ_GROWTH_FIXTURES={...messageGrowthFixtures};

if(import.meta.main){
  for(const [name,check] of Object.entries(READ_GROWTH_FIXTURES)){
    await check();console.log(`${name}: passed`);
  }
}
