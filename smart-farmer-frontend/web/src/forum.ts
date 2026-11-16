export const forumTopics = ['crops','livestock','soil','irrigation','equipment','markets','general'] as const;
export type ForumTopic = typeof forumTopics[number];
export const reportReasons = ['spam','abuse','unsafe_advice','privacy','other'] as const;
export type ForumEntry = {
  id:string; kind:'discussion'|'reply'; displayName:string; title:string|null; topic:ForumTopic|null;
  body:string; status:'visible'|'hidden'|'deleted'; version:number; createdAt:string; updatedAt:string;
  replyCount:number; mine:boolean; canEdit:boolean; canModerate:boolean; moderationReason?:string;
};
export type ForumPage<T> = {items:T[];nextCursor:string|null};
export type ForumThread = {discussion:ForumEntry;replies:ForumPage<ForumEntry>};
export type ForumReport = {id:string;target?:'author'|'content';reason:typeof reportReasons[number];details:string;reportedVersion:number;createdAt:string;entry:ForumEntry};
export type ForumComposer = {kind:'discussion'|'reply'|'edit';id:string;entry?:ForumEntry;discussionId?:string};

/** Preliminary Shona and Northern Ndebele copy follows the app's language-review policy. */
export const forumPhrases = {
  title:['Dare revarimi','Inkundla yabalimi'],
  intro:['Goveranai ruzivo, mibvunzo nezvamakaona pakurima.','Yabelanani ulwazi, imibuzo lalokho elikubonileyo ekulimeni.'],
  audience:['Mashoko aunogovera pano anoonekwa nevarimi vose vakapinda. Zita rekuratidza raunonyora rinoonekwa; zita rekupinda, zita repurazi nemafaira ako hazvibatanidzwi.','Ulwazi olwabelana lapha lubonwa ngabalimi bonke abangenileyo. Ibizo lokubonisa olibhalayo liyabonakala; ibizo lokungena, elepulazi lamafayela akho akufakwa.'],
  offline:['Dare rinoda indaneti. Zvinyorwa hazviiswe pamutsetse wekutumirwa uye hazvitumirwi zvoga kana indaneti yadzoka.','Inkundla idinga i-inthanethi. Imibhalo ayifakwa emzileni wokuthumela futhi ayithunyelwa yodwa nxa i-inthanethi ibuyile.'],
  block:['Vharira munyori','Vimba umbhali'], blockedAuthors:['Vanyori vawakavharira','Ababhali obavimbileyo'],
  unblock:['Bvisa kuvharira','Vula umbhali'], blockHint:['Iwe nemunyori uyu hamuchaonani zvinyorwa zvenyu mudare.','Wena lombhali lo kalisoze libone imibhalo yomunye enkundleni.'],
  blockSaved:['Munyori avharirwa.','Umbhali usevinjiwe.'], nobodyBlocked:['Hausati wavharira munyori.','Kawukavimbi umbhali.'],
  rules:['Mitemo yedare','Imithetho yenkundla'], agreeRules:['Ndaverenga uye ndinobvuma mitemo yedare.','Ngiyibalile njalo ngiyayamukela imithetho yenkundla.'],
  target:['Zvauri kumhan’ara','Okubikayo'], author:['Munyori','Umbhali'],
  newDiscussion:['Tanga hurukuro','Qalisa ingxoxo'],
  discussions:['Hurukuro','Izingxoxo'], mine:['Zvandakanyora','Engikubhalileyo'],
  all:['Misoro yose','Zonke izihloko'], topic:['Musoro wenyaya','Isihloko sendaba'],
  search:['Tsvaga muhurukuro','Dinga ezingxoxweni'], searchButton:['Tsvaga','Dinga'],
  empty:['Hapana hurukuro yawanikwa. Unogona kutanga imwe.','Akulangxoxo etholakeleyo. Ungaqalisa eyakho.'],
  displayName:['Zita richaonekwa munharaunda','Ibizo elizabonakala emphakathini'],
  nameHint:['Sarudza zita raunoda kuti vamwe vaone (mavara 2–50).','Khetha ibizo ofuna ukuthi abanye balibone (izinhlamvu 2–50).'],
  heading:['Musoro wehurukuro','Isihloko sengxoxo'],
  body:['Mashoko ako','Umbhalo wakho'], bodyHint:['Mavara anosvika 8 000. Zvakanyorwa chete; hapana faira repurazi rinowedzerwa.','Izinhlamvu ezifinyelela ku-8 000. Umbhalo kuphela; akulafayela lepulazi elengezwayo.'],
  consent:['Ndaongorora mashoko aya uye ndabvuma kuagovera nevarimi vose vakapinda.','Sengiwuhlolile lo mbhalo futhi ngiyavuma ukuwabelana labalimi bonke abangenileyo.'],
  share:['Govera munharaunda','Yabelana lomphakathi'], save:['Chengeta shanduko','Gcina utshintsho'],
  confirm:['Ndinobvuma','Ngiyavuma'],
  shared:['Mashoko agoverwa munharaunda.','Umbhalo usuwabelwe umphakathi.'],
  reply:['Pindura','Phendula'], replies:['Mhinduro','Impendulo'], noReplies:['Hapana mhinduro parizvino.','Akulampendulo okwamanje.'],
  more:['Ratidza zvimwe','Bonisa okunye'], back:['Dzokera kuhurukuro','Buyela ezingxoxweni'],
  edit:['Gadzirisa','Lungisa'], remove:['Bvisa','Susa'],
  removeHint:['Bvisa mashoko aya munharaunda? Kana iri hurukuro, mhinduro dzayo hadzichaonekwi. Izvi hazvidzoswi.','Susa lo mbhalo emphakathini? Nxa kuyingxoxo, impendulo zayo kazisabonakala. Lokhu akubuyiselwa.'],
  removed:['Munyori abvisa mashoko aya.','Umbhali uwususile lo mbhalo.'],
  hidden:['Mashoko aya akavanzwa kuti aongororwe.','Lo mbhalo ufihliwe ukuze uhlolwe.'],
  edited:['Zvakagadziriswa','Kulungisiwe'],
  report:['Mhan’ara','Bika'], reportTitle:['Mhan’ara mashoko aya','Bika lo mbhalo'],
  reportHint:['Chikonzero chinotumirwa kuvaridzi vepurazi rakagovera mashoko aya. Zita rako rekupinda hariratidzwi.','Isizatho sithunyelwa kubanikazi bepulazi elabele lo mbhalo. Ibizo lakho lokungena aliboniswa.'],
  reason:['Chikonzero','Isizatho'], details:['Zvimwe zvinobatsira kuongorora','Okunye okunceda ukuhlola'],
  reported:['Chichemo chatumirwa kuti chiongororwe.','Isikhalazo sithunyelwe ukuze sihlolwe.'],
  reports:['Zvichemo zvinoda kuongororwa','Izikhalazo ezidinga ukuhlolwa'],
  hiddenEntries:['Mashoko akavanzwa','Imibhalo efihliweyo'],
  moderationHint:['Varidzi vanongotarisira mashoko akagoverwa kuburikidza nepurazi rasarudzwa. Chikonzero chechisarudzo chinochengetwa.','Abanikazi bahlola kuphela imibhalo eyabelwe ngepulazi elikhethiweyo. Isizatho sesinqumo siyagcinwa.'],
  noReports:['Hapana zvichemo zvakamirira.','Akulazikhalazo ezilindileyo.'],
  noHidden:['Hapana mashoko akavanzwa papurazi iri.','Akulamibhalo efihliweyo kuleli pulazi.'],
  hide:['Vanza munharaunda','Fihla emphakathini'], restore:['Ratidza zvakare','Bonisa futhi'], dismiss:['Vhara chichemo pasina kuviga','Vala isikhalazo ungafihlanga'],
  moderationReason:['Chikonzero chechisarudzo (mavara 5–1 000)','Isizatho sesinqumo (izinhlamvu 5–1 000)'],
  moderationSaved:['Chisarudzo chachengetwa.','Isinqumo sigciniwe.'],
  changedSinceReport:['Mashoko aya akachinja kubva pakamhan’arwa. Ongorora mashoko azvino usati wasarudza.','Lo mbhalo utshintshile kusukela ekubikweni. Hlola umbhalo wamanje ungakenzi isinqumo.'],
  crops:['Zvirimwa','Izilimo'], livestock:['Zvipfuyo','Izifuyo'], soil:['Ivhu','Umhlabathi'],
  irrigation:['Mvura nekudiridza','Amanzi lokuthelelela'], equipment:['Michina nemidziyo','Imishini lezisetshenziswa'],
  markets:['Misika','Izimakethe'], general:['Zvimwe zvekurima','Okunye ngokulima'],
  spam:['Kushambadza kunovhiringidza','Ukukhangisa okuphazamisayo'], abuse:['Kutuka kana kushungurudza','Ukuthuka kumbe ukuhlukuluza'],
  unsafe_advice:['Zano ringakuvadza','Iseluleko esingalimaza'], privacy:['Mashoko akavanzika','Ulwazi oluyimfihlo'], other:['Chimwe chikonzero','Esinye isizatho'],
} as const;
export function forumText(language:'sn'|'nd') {
  const index=language==='sn'?0:1;
  return Object.fromEntries(Object.entries(forumPhrases).map(([key,value])=>[key,value[index]])) as Record<keyof typeof forumPhrases,string>;
}
