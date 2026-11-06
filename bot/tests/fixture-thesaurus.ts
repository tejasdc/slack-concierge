/** Keeps native-turn tests independent of Tejas's live thesaurus and capability entrance. */
export async function fixtureThesaurusContext(_text:string):Promise<string>{
  return 'Fixture thesaurus context.';
}
