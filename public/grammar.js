/* ══════════════════════════ 문법문제 출제 마법사 (2026-10-20) ══════════════════════════
   ① 레벨 → ② 문법 항목 → ③ 세부 항목 → ④ 고른 항목 → ⑤ 문항 수·모양·단을 한 화면 네 칸에 두고,
   [문제 만들기]로 /api/grammar를 불러 시험지를 만든다.
   app.js 뒤에 로드되며 app.js의 전역($, esc, postGenerate, buildQuizHtml, TAB_SAVE …)을 쓴다(trend.js와 같은 방식).

   만든 문항은 문제 탭과 같은 모양(format)이라 그리기는 buildQuizHtml, 반에 시험 내기는 openQuizAssign을 그대로 쓴다.
   목차(GRAMMAR_CATALOG)는 화면에만 있다 — 서버는 세부 항목 이름을 글자로 받는다. 고치려면 여기만 고치면 된다.
   세부 항목의 g는 처음 배우는 학년(0=초3~4 … 5=고등)이다. 그 학년부터 위 학년에서 모두 보인다.
   re가 있으면 '넣은 지문으로' 모드에서 지문에 그 문법이 보일 때 ✓를 단다(짐작일 뿐이다). */

/* 레벨 — 처음엔 초3~4·초5~6·중1·중2·중3·고등이었는데 다른 사이트를 따라 한 티가 난다고 해
   초등 고학년 · 중등 Level 1~3 · 수능 Level로 바꿨다(2026-10-20 사용자). lv는 목차의 g(처음 배우는
   단계: 0=초등 저학년 … 5=고등)와 견주는 값이다 — 초등 저학년(0) 항목은 초등 고학년부터 보인다. */
const GRAMMAR_GRADES = [
  { id: "e56", label: "초등 고학년", lv: 1 },
  { id: "m1", label: "중등 Level 1", lv: 2 },
  { id: "m2", label: "중등 Level 2", lv: 3 },
  { id: "m3", label: "중등 Level 3", lv: 4 },
  { id: "high", label: "수능 Level", lv: 5 },
];
// 문제 모양 — server.py의 GRAMMAR_MC_SHAPES·GRAMMAR_SA_SHAPES와 같은 열쇠(함께 고칠 것)
const GRAMMAR_MC_SHAPES = [
  { id: "mc_right", label: "옳은 문장 고르기" },
  { id: "mc_wrong", label: "틀린 문장 고르기" },
  { id: "mc_blank", label: "빈칸에 알맞은 말" },
  { id: "mc_underline", label: "밑줄 ①~⑤ 틀린 것" },
  { id: "mc_box", label: "네모 (A)(B)(C)" },
  { id: "mc_count", label: "옳은 문장 개수" },
  { id: "mc_combo", label: "옳은 것끼리 짝짓기" },
  { id: "mc_same", label: "쓰임이 다른 것" },
  { id: "mc_fixed", label: "바르게 고친 것" },
  { id: "mc_korean", label: "우리말 맞는 영문" },
];
const GRAMMAR_SA_SHAPES = [
  { id: "sa_verb", label: "동사 형태 바꾸기" },
  { id: "sa_fill", label: "빈칸 쓰기" },
  { id: "sa_fix", label: "틀린 곳 고쳐 쓰기" },
  { id: "sa_convert", label: "문장 전환" },
  { id: "sa_order", label: "배열 영작" },
  { id: "sa_compose", label: "조건 영작" },
  { id: "sa_combine", label: "두 문장 합치기" },
  { id: "sa_same", label: "같은 뜻 빈칸" },
];
const GRAMMAR_MAX_Q = 50;   // server.py GRAMMAR_MAX_QUESTIONS

const GRAMMAR_CATALOG = [
  { topic: "be동사와 일반동사", subs: [
    { name: "be동사 am/are/is", g: 0, re: /\b(am|are|is)\b/i },
    { name: "be동사의 부정문·의문문", g: 0, re: /\b(am|are|is|was|were)\s+not\b|\b(isn't|aren't|wasn't|weren't)\b/i },
    { name: "일반동사 현재형(3인칭 단수 -s)", g: 0 },
    { name: "일반동사의 부정문·의문문(do/does)", g: 1, re: /\b(don't|doesn't|didn't|do not|does not|did not)\b/i },
    { name: "be동사·일반동사의 과거형", g: 1, re: /\b(was|were)\b/i },
  ] },
  { topic: "문장의 종류", subs: [
    { name: "명령문(Let's / Don't)", g: 0, re: /\b(let's|don't)\b/i },
    { name: "의문사 의문문(who/what/when/where/why/how)", g: 0, re: /^(who|what|when|where|why|how)\b/im },
    { name: "감탄문(What a ~! / How ~!)", g: 2, re: /\b(what an?|how)\b[^.?!]*!/i },
    { name: "부가의문문", g: 2, re: /,\s*(isn't|aren't|don't|doesn't|didn't|won't|can't|is|are|do|does|did)\s+\w+\?/i },
    { name: "선택의문문(A or B)", g: 2 },
    { name: "간접의문문", g: 4, re: /\b(know|wonder|tell me|ask)\s+(who|what|when|where|why|how|if|whether)\b/i },
  ] },
  { topic: "시제", subs: [
    { name: "현재진행형(be + -ing)", g: 0, re: /\b(am|are|is)\s+\w+ing\b/i },
    { name: "과거시제(규칙·불규칙 변화)", g: 1 },
    { name: "미래시제(will / be going to)", g: 1, re: /\b(will|going to)\b/i },
    { name: "과거진행형", g: 2, re: /\b(was|were)\s+\w+ing\b/i },
    { name: "현재완료(경험·계속·완료·결과)", g: 3, re: /\b(have|has)\s+(never\s+|ever\s+|already\s+|just\s+)?\w+(ed|en|wn)\b/i },
    { name: "현재완료진행형", g: 4, re: /\b(have|has)\s+been\s+\w+ing\b/i },
    { name: "과거완료(had p.p.)", g: 4, re: /\bhad\s+\w+(ed|en|wn)\b/i },
    { name: "시제 일치와 예외", g: 5 },
    { name: "현재완료 vs 과거시제(yesterday·ago·when과 현재완료 불가)", g: 5, re: /\b(have|has)\s+\w+(ed|en|wn)\b[^.]*\b(ago|yesterday|last (year|week|month))\b/i },
    { name: "미래완료(will have p.p.)·과거완료진행", g: 5, re: /\bwill\s+have\s+\w+(ed|en|wn)\b|\bhad\s+been\s+\w+ing\b/i },
    { name: "미래를 나타내는 현재·현재진행 / be about to", g: 5, re: /\b(am|are|is)\s+about\s+to\b/i },
    { name: "진행형으로 쓰지 않는 동사(상태동사: know/belong/resemble)", g: 5, re: /\b(belongs?|resembles?|owns?|consists?)\b/i },
  ] },
  { topic: "조동사", subs: [
    { name: "can / may (능력·허가·추측)", g: 0, re: /\b(can|may)\b/i },
    { name: "must / have to (의무)", g: 1, re: /\b(must|have to|has to)\b/i },
    { name: "should / had better", g: 2, re: /\b(should|had better)\b/i },
    { name: "would like to / used to", g: 3, re: /\b(would like to|used to)\b/i },
    { name: "조동사 + have p.p. (과거 추측·후회)", g: 5, re: /\b(must|should|could|may|might|can't)\s+have\s+\w+(ed|en|wn)\b/i },
    { name: "주장·요구·제안 동사 + that + (should) 동사원형", g: 5, re: /\b(insist|insisted|suggest|suggested|demand|demanded|recommend|recommended|require|required|propose|proposed)\s+that\b/i },
    { name: "대동사 do(앞의 동사 대신하기)", g: 5, re: /\b(than|as)\s+(I|you|he|she|we|they|it)\s+(do|does|did)\b/i },
    { name: "used to / be used to -ing / be used to 동사원형 구분", g: 5, re: /\b(used to|be used to|is used to|are used to)\b/i },
    { name: "조동사 관용 표현(would rather / may well / cannot ~ too)", g: 5, re: /\b(would rather|may well|may as well|might as well|cannot\s+\w+\s+too)\b/i },
  ] },
  { topic: "명사와 관사", subs: [
    { name: "셀 수 있는 명사의 복수형", g: 0 },
    { name: "셀 수 없는 명사와 수량 표현(a piece of …)", g: 1, re: /\ba (piece|glass|cup|bottle|slice) of\b/i },
    { name: "부정관사 a/an과 정관사 the", g: 1 },
    { name: "관사를 쓰지 않는 경우", g: 2 },
  ] },
  { topic: "대명사", subs: [
    { name: "인칭대명사의 격(I-my-me-mine)", g: 0 },
    { name: "this/that, these/those", g: 0, re: /\b(these|those)\b/i },
    { name: "비인칭 주어 it", g: 1, re: /\bit\s+is\s+(\w+\s+)?(o'clock|sunny|rainy|cold|hot|warm|dark|far)\b/i },
    { name: "부정대명사(one / another / other / the other)", g: 3, re: /\b(another|the other|others)\b/i },
    { name: "재귀대명사(-self)", g: 3, re: /\b\w+self\b|\b\w+selves\b/i },
    { name: "some / any, every / each / all", g: 2, re: /\b(each|every)\b/i },
    { name: "대명사의 수 일치(it/they, its/their)", g: 5 },
    { name: "지시대명사 that / those(앞 명사 반복 대신)", g: 5, re: /\b(than|as)\s+(that|those)\s+of\b/i },
    { name: "each / every / either / neither / both의 수 일치", g: 5, re: /\b(each|either|neither|both)\s+(of\s+)?\w+/i },
  ] },
  { topic: "형용사와 부사", subs: [
    { name: "형용사의 쓰임(명사 꾸미기·보어)", g: 0 },
    { name: "수량 형용사(many/much, (a) few/(a) little)", g: 2, re: /\b(a few|a little|few|little|many|much)\b/i },
    { name: "부사의 형태와 위치", g: 1, re: /\b\w+ly\b/i },
    { name: "빈도부사(always/usually/often/never)", g: 1, re: /\b(always|usually|often|sometimes|never|seldom)\b/i },
    { name: "-thing + 형용사", g: 3, re: /\b(something|anything|nothing|everything)\s+\w+/i },
    { name: "형용사 자리 vs 부사 자리(보어·목적격 보어에는 형용사)", g: 5 },
    { name: "주의할 부사(hard/hardly, late/lately, near/nearly, high/highly)", g: 5, re: /\b(hardly|lately|nearly|highly|mostly|closely)\b/i },
    { name: "so / such / too / enough의 어순", g: 5, re: /\bsuch\s+an?\b|\b\w+\s+enough\s+to\b/i },
  ] },
  { topic: "비교", subs: [
    { name: "비교급·최상급 만들기", g: 1, re: /\b\w+er than\b|\bthe \w+est\b|\bmore \w+ than\b|\bthe most\b/i },
    { name: "원급 비교(as ~ as)", g: 2, re: /\bas\s+\w+\s+as\b/i },
    { name: "비교급 강조(much/even/far)", g: 3, re: /\b(much|even|far|a lot)\s+\w+er\b/i },
    { name: "the 비교급, the 비교급", g: 4, re: /\bthe\s+\w+er\b[^.]*,\s*the\s+\w+er\b/i },
    { name: "배수 비교·최상급 대용 표현", g: 5, re: /\b(twice|three times|half)\s+as\b|\bthan any other\b/i },
    { name: "원급 관용 표현(as ~ as possible / not so much A as B)", g: 5, re: /\bas\s+\w+\s+as\s+(possible|\w+\s+can)\b|\bnot so much\b/i },
    { name: "비교급 관용 표현(비교급 and 비교급 / no longer / no more than)", g: 5, re: /\b(\w+er)\s+and\s+\1\b|\bmore and more\b|\bno longer\b|\bno (more|less) than\b/i },
    { name: "비교 대상의 일치(than 뒤 형태 맞추기)", g: 5, re: /\bthan\s+(that|those)\s+of\b/i },
  ] },
  { topic: "전치사", subs: [
    { name: "장소 전치사(in/on/under/next to)", g: 0 },
    { name: "시간 전치사(at/on/in, for/during, by/until)", g: 1, re: /\b(during|until)\b/i },
    { name: "전치사 + 동명사", g: 3, re: /\b(in|on|of|for|about|without|by)\s+\w+ing\b/i },
    { name: "전치사 vs 접속사(during/while, because of/because, despite/although)", g: 5, re: /\b(despite|in spite of|because of|due to)\b/i },
  ] },
  { topic: "문장의 형식", subs: [
    { name: "감각동사 + 형용사(look/sound/feel)", g: 2, re: /\b(looks?|sounds?|feels?|smells?|tastes?)\s+(so\s+|very\s+)?\w+/i },
    { name: "4형식(수여동사)과 3형식 전환", g: 2, re: /\b(gave|give|gives|showed|show|sent|send|bought|buy|told|tell|made|make)\s+(me|him|her|us|them|you)\s+\w+/i },
    { name: "5형식(목적격 보어: make/call/keep)", g: 3 },
    { name: "사역동사(make/have/let) + 동사원형", g: 4, re: /\b(made|make|makes|let|lets|had|have|has)\s+(me|him|her|us|them|you|it)\s+\w+\b/i },
    { name: "지각동사(see/hear/feel) + 동사원형/-ing", g: 4, re: /\b(saw|see|heard|hear|felt|feel|watched|watch)\s+(me|him|her|us|them|you|it|\w+)\s+\w+ing\b/i },
    { name: "헷갈리는 자동사·타동사(lie/lay, rise/raise, discuss·resemble)", g: 5, re: /\b(lie|lay|lain|laid|rise|rose|risen|raise|raised|discuss|resemble)\b/i },
    { name: "목적격 보어의 형태(help + (to) 원형 / get + to부정사 / have + p.p.)", g: 5, re: /\b(help|helps|helped)\s+\w+\s+(to\s+)?\w+|\b(have|has|had|get|gets|got)\s+(my|his|her|their|our|your|the|a|an|it|them)\s+(\w+\s+)?\w+(ed|en)\b/i },
  ] },
  { topic: "to부정사", subs: [
    { name: "명사적 용법(주어·목적어·보어)", g: 2, re: /\b(want|wants|wanted|decide|decided|plan|planned|hope|hoped)\s+to\s+\w+/i },
    { name: "형용사적 용법", g: 2, re: /\b(something|anything|nothing|time|way|chance)\s+to\s+\w+/i },
    { name: "부사적 용법(목적·감정의 원인·결과)", g: 3 },
    { name: "가주어 it ~ to부정사", g: 3, re: /\bit\s+is\s+\w+\s+(for\s+\w+\s+)?to\s+\w+/i },
    { name: "의문사 + to부정사", g: 3, re: /\b(how|what|where|when|which)\s+to\s+\w+/i },
    { name: "too ~ to / enough to", g: 4, re: /\btoo\s+\w+\s+to\b|\benough\s+to\b/i },
    { name: "목적격 보어로 쓰이는 to부정사(want/ask/tell + 목적어 + to)", g: 4, re: /\b(want|wanted|asked|ask|told|tell|allowed|allow|expect|expected)\s+(me|him|her|us|them|you)\s+to\b/i },
    { name: "to부정사의 의미상 주어(for/of)", g: 4, re: /\bit\s+is\s+\w+\s+(for|of)\s+\w+\s+to\b/i },
    { name: "to부정사의 시제·수동(to have p.p. / to be p.p.)", g: 5, re: /\bto\s+(have|be)\s+\w+(ed|en|wn)\b/i },
    { name: "가목적어 it(make / find / think it ~ to부정사)", g: 5, re: /\b(make|makes|made|find|finds|found|think|thought|consider)\s+it\s+\w+\s+(for\s+\w+\s+)?to\b/i },
    { name: "be to 용법(예정·의무·가능·운명·의도)", g: 5, re: /\b(am|are|is|was|were)\s+to\s+(be|\w+)\b/i },
    { name: "seem / appear to ~ (It seems that 전환)", g: 5, re: /\b(seems?|seemed|appears?|appeared)\s+to\b|\bit\s+(seems|seemed|appears)\s+that\b/i },
    { name: "독립부정사(to be honest / to make matters worse)", g: 5, re: /\b(to be honest|to tell the truth|to make matters worse|needless to say|so to speak|to begin with)\b/i },
  ] },
  { topic: "동명사", subs: [
    { name: "동명사의 쓰임(주어·목적어·보어)", g: 2, re: /\b\w+ing\s+(is|was)\b/i },
    { name: "동명사만 / to부정사만 목적어로 쓰는 동사", g: 3, re: /\b(enjoy|enjoyed|finish|finished|mind|avoid|gave up|keep|kept)\s+\w+ing\b/i },
    { name: "동명사와 to부정사의 의미 차이(remember/forget/stop/try)", g: 4, re: /\b(remember|forget|stop|try|regret)(s|ed)?\s+(to\s+\w+|\w+ing)\b/i },
    { name: "동명사 관용 표현(be used to -ing, look forward to -ing)", g: 4, re: /\b(look forward to|be used to|used to|feel like|be busy|cannot help)\s+\w+ing\b/i },
    { name: "동명사의 의미상 주어·완료형·수동형(having p.p. / being p.p.)", g: 5, re: /\b(having|being)\s+\w+(ed|en|wn)\b|\b(his|her|my|their|your)\s+\w+ing\b/i },
  ] },
  { topic: "분사", subs: [
    { name: "현재분사와 과거분사(명사 수식)", g: 3, re: /\b(the|a|an)\s+\w+(ing|ed|en)\s+\w+/i },
    { name: "감정 분사(-ing / -ed: interesting/interested)", g: 3, re: /\b(interest|excit|bor|surpris|tir|disappoint|amaz|satisf)(ing|ed)\b/i },
    { name: "분사구문(기본)", g: 4, re: /^[\s"]*\w+ing\b[^,]{0,60},/m },
    { name: "분사구문(완료·수동·with + 명사 + 분사)", g: 5, re: /\bhaving\s+\w+(ed|en|wn)\b|\bwith\s+\w+\s+\w+(ing|ed)\b/i },
    { name: "접속사·주어를 남긴 분사구문(독립분사구문 / When -ing)", g: 5, re: /\b(when|while|after|before|though|if)\s+\w+ing\b/i },
    { name: "분사구문의 관용 표현(generally speaking / considering / judging from)", g: 5, re: /\b(generally|frankly|strictly) speaking\b|\b(considering|judging from|given that)\b/i },
    { name: "분사의 능동·수동 판단(-ing vs p.p.)", g: 5 },
  ] },
  { topic: "수동태", subs: [
    { name: "수동태의 기본 형태(be + p.p.)", g: 3, re: /\b(am|is|are|was|were|be|been)\s+\w+(ed|en|wn)\b(\s+by\b)?/i },
    { name: "수동태의 시제(진행·완료·조동사)", g: 4, re: /\b(being|been)\s+\w+(ed|en|wn)\b|\b(will|can|must|should)\s+be\s+\w+(ed|en|wn)\b/i },
    { name: "by 이외의 전치사를 쓰는 수동태", g: 4, re: /\b(interested|covered|filled|made|known|satisfied|pleased)\s+(in|with|of|from|for|to)\b/i },
    { name: "4·5형식의 수동태", g: 5 },
    { name: "동사구의 수동태(be taken care of)", g: 5 },
    { name: "that절 목적어의 수동태(It is said that ~ / He is said to ~)", g: 5, re: /\bit\s+(is|was)\s+(said|believed|thought|reported|known)\s+that\b|\b(is|are|was|were)\s+(said|believed|thought|known|reported)\s+to\b/i },
    { name: "수동태로 쓰지 않는 동사(happen / appear / resemble / have)", g: 5, re: /\b(happen|happened|occur|occurred|appear|appeared|disappear|disappeared|resemble|resembled)\b/i },
  ] },
  { topic: "접속사", subs: [
    { name: "and / but / or / so", g: 0 },
    { name: "시간 접속사(when / before / after / while / until)", g: 2, re: /\b(when|before|after|while|until)\s+\w+/i },
    { name: "이유·조건 접속사(because / if / unless)", g: 2, re: /\b(because|if|unless)\b/i },
    { name: "명사절을 이끄는 that", g: 2, re: /\b(think|know|believe|hope|said|says)\s+that\b/i },
    { name: "상관접속사(both A and B / either A or B / not only A but also B)", g: 4, re: /\b(both|either|neither|not only)\b/i },
    { name: "양보 접속사(though / although / even if)", g: 4, re: /\b(though|although|even if|even though)\b/i },
    { name: "so ~ that / so that", g: 3, re: /\bso\s+\w+\s+that\b|\bso that\b/i },
    { name: "if / whether(~인지 아닌지)", g: 4, re: /\bwhether\b/i },
    { name: "시간·조건 부사절의 시제(미래 대신 현재)", g: 5, re: /\b(when|if|until|before|after|as soon as|unless)\s+\w+\s+\w+s\b[^.]*\bwill\b/i },
    { name: "접속사 that vs 관계대명사 what(뒤 문장의 완전·불완전)", g: 5 },
    { name: "목적·결과의 부사절(so that / in order that / such ~ that)", g: 5, re: /\b(in order that|so that|such\s+an?\s+\w+(\s+\w+)?\s+that)\b/i },
  ] },
  { topic: "관계사", subs: [
    { name: "주격 관계대명사(who / which / that)", g: 3, re: /\b\w+\s+(who|which|that)\s+(is|are|was|were|has|have|\w+s)\b/i },
    { name: "목적격 관계대명사와 생략", g: 3, re: /\b(whom|which|that)\s+(I|you|he|she|we|they)\b/i },
    { name: "소유격 관계대명사 whose", g: 4, re: /\bwhose\b/i },
    { name: "관계대명사 what", g: 4, re: /\bwhat\s+(I|you|he|she|we|they)\s+\w+/i },
    { name: "관계부사(where / when / why / how)", g: 4, re: /\b(place|day|year|time|reason|town|city|house)\s+(where|when|why)\b/i },
    { name: "관계사의 계속적 용법(, which / , who)", g: 5, re: /,\s*(which|who)\b/i },
    { name: "전치사 + 관계대명사", g: 5, re: /\b(in|on|at|with|for|to|of|about)\s+(which|whom)\b/i },
    { name: "복합관계사(whoever / whatever / however)", g: 5, re: /\b(whoever|whatever|whichever|however|wherever|whenever)\b/i },
    { name: "관계대명사 vs 관계부사(뒤 문장의 완전·불완전)", g: 5 },
    { name: "관계사절의 수 일치(선행사에 맞춘 동사)", g: 5, re: /\b(who|which|that)\s+(is|are|was|were|has|have)\b/i },
  ] },
  { topic: "가정법", subs: [
    { name: "가정법 과거", g: 4, re: /\bif\s+\w+\s+(were|had|knew|could|did)\b[^.]*\b(would|could|might)\b/i },
    { name: "가정법 과거완료", g: 5, re: /\bif\s+\w+\s+had\s+\w+(ed|en|wn)\b/i },
    { name: "I wish / as if 가정법", g: 4, re: /\b(I wish|as if|as though)\b/i },
    { name: "혼합 가정법·without(but for) 가정법", g: 5, re: /\b(without|but for)\b/i },
    { name: "if의 생략과 도치(Were I ~, Had I ~)", g: 5, re: /^(Were|Had|Should)\s+(I|you|he|she|we|they|it)\b/m },
    { name: "가정법을 이끄는 표현(It's time / otherwise / suppose / provided)", g: 5, re: /\b(it's (high |about )?time|otherwise|suppose|supposing|provided|providing)\b/i },
  ] },
  { topic: "일치와 특수구문", subs: [
    { name: "주어와 동사의 수 일치", g: 3 },
    { name: "강조(It is ~ that / do 강조)", g: 5, re: /\bit\s+(is|was)\s+[^.]{1,40}\s+that\b|\b(do|does|did)\s+(really\s+)?(love|like|want|know|need)\b/i },
    { name: "도치(부정어·장소 부사구)", g: 5, re: /^(Never|Rarely|Little|Not only|Hardly|Seldom|Only)\b/m },
    { name: "간접화법", g: 5, re: /\b(said|told|asked)\s+(me\s+|him\s+|her\s+)?(that|if|whether|to)\b/i },
    { name: "병렬 구조", g: 5 },
    { name: "주의할 수 일치(the number of / a number of / most of + 명사)", g: 5, re: /\b(the number of|a number of|most of|some of|half of|the rest of|percent of)\b/i },
    { name: "동사 vs 준동사(문장의 동사 자리 판별)", g: 5 },
    { name: "도치(보어 / so·neither + 동사 + 주어)", g: 5, re: /\b(so|neither|nor)\s+(do|does|did|am|is|are|was|were|have|has|can|will)\s+(I|you|he|she|we|they|it)\b/i },
    { name: "생략(반복 어구·부사절의 주어 + be)", g: 5 },
    { name: "동격(the fact that ~)·삽입", g: 5, re: /\bthe (fact|idea|news|belief|evidence|possibility) that\b/i },
    { name: "부정(부분부정 not all / 전체부정 / 이중부정)", g: 5, re: /\bnot\s+(all|always|every|necessarily|entirely)\b|\bnever\s+\w+\s+without\b/i },
  ] },
];
const GRAMMAR_GRADE_IDX = Object.fromEntries(GRAMMAR_GRADES.map((g) => [g.id, g.lv]));

/* ── 상태 ── */
const grState = {
  grade: "m1",
  topic: null,              // STEP 2에서 고른 항목 이름
  picked: [],               // STEP 4 — [{name, mc, sa}] (name = "항목 › 세부")
  mode: "plain",            // plain = 문법만 / passage = 넣은 지문으로
  split: "auto",            // auto = 고르게 나누기 / manual = 항목마다 직접
  mcTotal: 5, saTotal: 5,   // 기본 10문제(객관식 5 + 주관식 5) — 2026-10-20 사용자 결정
  aiPick: true,
  mcShapes: GRAMMAR_MC_SHAPES.map((s) => s.id),
  saShapes: GRAMMAR_SA_SHAPES.map((s) => s.id),
  cols: 2,
  title: "",
  questions: [],
  busy: false,
};

const grEl = (id) => document.getElementById(id);

// '넣은 지문으로' 모드일 때만 공용 지문칸을 보인다(app.js syncTabChrome이 묻는다)
function grammarWantsPassage() { return grState.mode === "passage"; }

function grPassageText() {
  if (grState.mode !== "passage" || typeof passageMgr === "undefined") return "";
  return passageMgr.getJobs().map((j) => String(j.text || "").trim()).filter(Boolean).join("\n\n");
}

/* ── STEP 1~4 그리기 ── */
function grRenderGrades() {
  grEl("grGradeList").innerHTML = GRAMMAR_GRADES.map((g) =>
    `<label class="gr-level${g.id === grState.grade ? " picked" : ""}"><input type="radio" name="grGrade" value="${g.id}"${g.id === grState.grade ? " checked" : ""}> ${esc(g.label)}</label>`).join("");
}

function grVisibleSubs(topic) {
  const lim = GRAMMAR_GRADE_IDX[grState.grade];
  return (topic.subs || []).filter((s) => s.g <= lim);
}

function grRenderTopics() {
  const text = grPassageText();
  const topics = GRAMMAR_CATALOG.filter((t) => grVisibleSubs(t).length);
  if (!topics.some((t) => t.topic === grState.topic)) grState.topic = null;
  grEl("grTopicList").innerHTML = topics.map((t) => {
    const n = grState.picked.filter((p) => p.name.startsWith(t.topic + " › ")).length;
    const seen = text && grVisibleSubs(t).some((s) => s.re && s.re.test(text));
    return `<label class="gr-topic${t.topic === grState.topic ? " on" : ""}">
      <input type="radio" name="grTopic" value="${esc(t.topic)}"${t.topic === grState.topic ? " checked" : ""}>
      <span>${esc(t.topic)}</span>${seen ? `<span class="gr-seen" title="넣은 지문에 이 문법이 보입니다(짐작)">✓ 지문</span>` : ""}
      ${n ? `<span class="gr-count">${n}</span>` : ""}</label>`;
  }).join("");
}

function grRenderSubs() {
  const box = grEl("grSubList");
  const t = GRAMMAR_CATALOG.find((x) => x.topic === grState.topic);
  if (!t) {
    box.innerHTML = `<p class="gr-empty">왼쪽에서 문법 항목을 고르세요.</p>`;
    return;
  }
  const text = grPassageText();
  const subs = grVisibleSubs(t);
  box.innerHTML = `<label class="gr-sub gr-sub-all"><input type="checkbox" id="grSubAll"> <b>전체 선택</b></label>` +
    subs.map((s) => {
      const name = `${t.topic} › ${s.name}`;
      const on = grState.picked.some((p) => p.name === name);
      const seen = text && s.re && s.re.test(text);
      return `<label class="gr-sub"><input type="checkbox" data-name="${esc(name)}"${on ? " checked" : ""}>
        <span>${esc(s.name)}</span>
        ${seen ? `<span class="gr-seen" title="넣은 지문에 이 문법이 보입니다(짐작)">✓ 지문</span>` : ""}</label>`;
    }).join("");
  const all = box.querySelectorAll("input[data-name]");
  grEl("grSubAll").checked = all.length > 0 && [...all].every((c) => c.checked);
}

function grRenderPicked() {
  const box = grEl("grPickedList");
  const manual = grState.split === "manual";
  if (!grState.picked.length) {
    box.innerHTML = `<p class="gr-empty">세부 항목을 체크하면 여기에 모입니다.</p>`;
  } else {
    box.innerHTML = grState.picked.map((p, i) => `
      <div class="gr-picked" data-i="${i}">
        <span class="gr-picked-name">${esc(p.name)}</span>
        <span class="gr-picked-n">객 <input type="number" min="0" max="${GRAMMAR_MAX_Q}" class="gr-n" data-k="mc" value="${p.mc}"${manual ? "" : " disabled"}>
          주 <input type="number" min="0" max="${GRAMMAR_MAX_Q}" class="gr-n" data-k="sa" value="${p.sa}"${manual ? "" : " disabled"}></span>
        <button type="button" class="gr-x" title="빼기">✕</button>
      </div>`).join("");
  }
  grEl("grPickedCount").textContent = grState.picked.length ? `(${grState.picked.length}개)` : "";
}

/* 고르게 나누기 — 객관식·주관식 총수를 항목 수로 나누고, 남는 문항은 객관식은 앞 항목부터,
   주관식은 뒤 항목부터 하나씩 더 준다(한 항목에 몰리지 않게). */
function grDistribute() {
  const list = grState.picked;
  const n = list.length;
  if (!n || grState.split === "manual") return;
  const mc = Math.max(0, grState.mcTotal | 0), sa = Math.max(0, grState.saTotal | 0);
  list.forEach((p, i) => {
    p.mc = Math.floor(mc / n) + (i < mc % n ? 1 : 0);
    p.sa = Math.floor(sa / n) + (n - 1 - i < sa % n ? 1 : 0);
  });
}

function grTotals() {
  if (grState.split === "manual") {
    return {
      mc: grState.picked.reduce((a, p) => a + (p.mc | 0), 0),
      sa: grState.picked.reduce((a, p) => a + (p.sa | 0), 0),
    };
  }
  return grState.picked.length ? { mc: grState.mcTotal | 0, sa: grState.saTotal | 0 } : { mc: 0, sa: 0 };
}

// 시험지 한 장에 기본값 + 문제당(객관식·주관식 합쳐서) — server.py _grammar_cost와 같은 식
function grCost(mc, sa) {
  if (typeof PRICING === "undefined" || !PRICING || !Number.isFinite(PRICING.grammarBase)) return null;
  const n = Math.max(0, mc) + Math.max(0, sa);
  return n ? PRICING.grammarBase + PRICING.grammarPerQ * n : 0;
}

function grSyncStep5() {
  const manual = grState.split === "manual";
  const t = grTotals();
  const mcIn = grEl("grMcTotal"), saIn = grEl("grSaTotal");
  mcIn.disabled = saIn.disabled = manual;
  if (manual || document.activeElement !== mcIn) mcIn.value = t.mc;
  if (manual || document.activeElement !== saIn) saIn.value = t.sa;
  const sum = t.mc + t.sa;
  grEl("grSum").textContent = sum;
  const over = sum > GRAMMAR_MAX_Q;
  grEl("grSum").classList.toggle("over", over);
  const cost = grCost(t.mc, t.sa);
  grEl("grCostHint").innerHTML = over
    ? `<span class="gr-warn">한 번에 ${GRAMMAR_MAX_Q}문항까지 만들 수 있습니다.</span>`
    : sum && cost !== null ? `예상 비용 <b>${pt(cost)}</b> (기본 ${pt(PRICING.grammarBase)} + 문제당 ${pt(PRICING.grammarPerQ)} × ${sum}문제)` : "";
  grEl("grMakeBtn").disabled = grState.busy || !grState.picked.length || !sum || over;
  document.querySelectorAll('input[name="grCols"]').forEach((r) => { r.checked = Number(r.value) === grState.cols; });
  document.querySelectorAll('input[name="grSplit"]').forEach((r) => { r.checked = r.value === grState.split; });
  document.querySelectorAll('input[name="grMode"]').forEach((r) => { r.checked = r.value === grState.mode; });
  grEl("grAiPick").checked = grState.aiPick;
  grEl("grShapeHint").textContent = grState.aiPick
    ? "체크한 모양 중에서 AI가 세부 항목에 알맞은 것을 골라 섞습니다."
    : "체크한 모양을 차례로 돌려 가며 씁니다.";
}

function grRenderAll() {
  grRenderGrades();
  grRenderTopics();
  grRenderSubs();
  grDistribute();
  grRenderPicked();
  grSyncStep5();
}

function grRenderShapes() {
  const row = (list, key) => list.map((s) =>
    `<label class="chk"><input type="checkbox" data-shape="${s.id}" data-key="${key}"${grState[key].includes(s.id) ? " checked" : ""}> ${esc(s.label)}</label>`).join("");
  grEl("grMcShapes").innerHTML = row(GRAMMAR_MC_SHAPES, "mcShapes");
  grEl("grSaShapes").innerHTML = row(GRAMMAR_SA_SHAPES, "saShapes");
}

/* ── 입력 연결 ── */
grEl("grGradeList").addEventListener("change", (e) => {
  if (e.target.name !== "grGrade") return;
  grState.grade = e.target.value;
  // 새 레벨에 없는 세부 항목은 뺀다(선생님이 직접 적은 항목은 남긴다)
  const lim = GRAMMAR_GRADE_IDX[grState.grade];
  grState.picked = grState.picked.filter((p) => {
    const [topic, sub] = p.name.split(" › ");
    const t = GRAMMAR_CATALOG.find((x) => x.topic === topic);
    const s = t && t.subs.find((x) => x.name === sub);
    return !s || s.g <= lim;
  });
  grRenderAll();
});
grEl("grTopicList").addEventListener("change", (e) => {
  if (e.target.name !== "grTopic") return;
  grState.topic = e.target.value;
  grRenderTopics();
  grRenderSubs();
});
grEl("grSubList").addEventListener("change", (e) => {
  const boxes = [...grEl("grSubList").querySelectorAll("input[data-name]")];
  const targets = e.target.id === "grSubAll" ? boxes.map((b) => { b.checked = e.target.checked; return b; }) : [e.target];
  targets.forEach((b) => {
    const name = b.dataset.name;
    if (!name) return;
    const at = grState.picked.findIndex((p) => p.name === name);
    if (b.checked && at < 0) grState.picked.push({ name, mc: 1, sa: 1 });
    if (!b.checked && at >= 0) grState.picked.splice(at, 1);
  });
  grRenderAll();
});
grEl("grPickedList").addEventListener("click", (e) => {
  if (!e.target.closest(".gr-x")) return;
  const i = Number(e.target.closest(".gr-picked").dataset.i);
  grState.picked.splice(i, 1);
  grRenderAll();
});
grEl("grPickedList").addEventListener("input", (e) => {
  if (!e.target.classList.contains("gr-n")) return;
  const i = Number(e.target.closest(".gr-picked").dataset.i);
  grState.picked[i][e.target.dataset.k] = Math.max(0, Math.min(GRAMMAR_MAX_Q, parseInt(e.target.value, 10) || 0));
  grSyncStep5();
});
// 고른 항목을 모두 비운다 — 레벨·문항 수·모양 설정과 만든 시험지는 건드리지 않는다
grEl("grResetBtn").addEventListener("click", () => {
  if (!grState.picked.length && !grState.topic) return;
  if (grState.picked.length > 1 && !confirm(`고른 세부 항목 ${grState.picked.length}개를 모두 지울까요?`)) return;
  grState.picked = [];
  grState.topic = null;
  grEl("grCustom").value = "";
  grEl("grError").textContent = "";
  grRenderAll();
});
grEl("grCustomAdd").addEventListener("click", () => {
  const el = grEl("grCustom");
  const v = el.value.trim().slice(0, 80);
  if (!v) return;
  const name = `직접 입력 › ${v}`;
  if (!grState.picked.some((p) => p.name === name)) grState.picked.push({ name, mc: 1, sa: 1 });
  el.value = "";
  grRenderAll();
});
grEl("grCustom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); grEl("grCustomAdd").click(); }
});
["grMcTotal", "grSaTotal"].forEach((id) => grEl(id).addEventListener("input", (e) => {
  const v = Math.max(0, Math.min(GRAMMAR_MAX_Q, parseInt(e.target.value, 10) || 0));
  grState[id === "grMcTotal" ? "mcTotal" : "saTotal"] = v;
  grDistribute();
  grRenderPicked();
  grSyncStep5();
}));
document.querySelectorAll('input[name="grSplit"]').forEach((r) => r.addEventListener("change", () => {
  // 직접 나누기로 바꿀 때는 지금 고르게 나눈 값을 그대로 출발점으로 둔다
  grState.split = r.value;
  if (r.value === "auto") {
    const t = { mc: grState.picked.reduce((a, p) => a + p.mc, 0), sa: grState.picked.reduce((a, p) => a + p.sa, 0) };
    if (t.mc + t.sa) { grState.mcTotal = t.mc; grState.saTotal = t.sa; }
  }
  grRenderAll();
}));
document.querySelectorAll('input[name="grMode"]').forEach((r) => r.addEventListener("change", () => {
  grState.mode = r.value;
  syncTabChrome("grammar");
  grRenderAll();
  if (grState.mode === "passage" && !grPassageText()) {
    grEl("grError").textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요. 그 지문의 문장으로 문제를 만듭니다.";
  } else grEl("grError").textContent = "";
}));
grEl("grAiPick").addEventListener("change", (e) => { grState.aiPick = e.target.checked; grSyncStep5(); });
["grMcShapes", "grSaShapes"].forEach((id) => grEl(id).addEventListener("change", (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  const on = [...grEl(id).querySelectorAll("input:checked")].map((c) => c.dataset.shape);
  if (!on.length) {   // 하나는 남겨 둔다 — 다 끄면 무엇으로 만들지 모른다
    e.target.checked = true;
    return;
  }
  grState[key] = on;
}));
document.querySelectorAll('input[name="grCols"]').forEach((r) => r.addEventListener("change", () => {
  grState.cols = Number(r.value) === 1 ? 1 : 2;
  grEl("grResult").classList.toggle("gr-1col", grState.cols === 1);
}));
grEl("grTitle").addEventListener("input", (e) => {
  grState.title = e.target.value.trim();
  grApplyTitle();
});
// 공용 지문칸이 바뀌면 ✓ 표시를 다시 단다(지문 모드일 때만 의미가 있다)
document.addEventListener("input", (e) => {
  if (grState.mode === "passage" && e.target.closest && e.target.closest(".passage-panel")) {
    grRenderTopics();
    grRenderSubs();
  }
});

/* ── 만들기 ── */
function grRequest() {
  return {
    grade: grState.grade,
    items: grState.picked.filter((p) => p.mc + p.sa > 0).map((p) => ({ name: p.name, mc: p.mc, sa: p.sa })),
    mcShapes: grState.mcShapes,
    saShapes: grState.saShapes,
    aiPick: grState.aiPick,
    passage: grPassageText(),
  };
}

async function grMake() {
  const errEl = grEl("grError");
  errEl.textContent = "";
  if (grState.mode === "passage" && !grPassageText()) {
    errEl.textContent = "‘넣은 지문으로’를 골랐습니다. 위쪽 영어 지문 칸에 지문을 넣어 주세요.";
    return;
  }
  const t = grTotals();
  const cost = grCost(t.mc, t.sa);
  if (!(await costConfirmed(cost, `문법 문제 ${t.mc + t.sa}문항 (객관식 ${t.mc} · 주관식 ${t.sa})`))) return;
  grState.busy = true;
  grSyncStep5();
  const loading = grEl("grLoading");
  loading.classList.add("on");
  grEl("grLoadingText").textContent = `AI가 문법 문제 ${t.mc + t.sa}문항을 만들고 있습니다… (20문항에 30초~1분)`;
  try {
    const data = await postGenerate("/api/grammar", grRequest(), "문법 문제를 만들지 못했습니다.",
      (n) => { grEl("grLoadingText").textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
    grState.questions = data.questions || [];
    if (typeof LOADED_SAVED !== "undefined") delete LOADED_SAVED.grammar;   // 새로 만든 것은 어느 저장본도 아니다
    grRender();
    if (data.missing) errEl.textContent = `${data.missing}문항은 만들지 못해 빠졌습니다(값은 받은 문항만큼만 나갔습니다).`;
  } catch (err) {
    errEl.textContent = err.message || "문법 문제를 만들지 못했습니다.";
  } finally {
    grState.busy = false;
    loading.classList.remove("on");
    grSyncStep5();
    refreshTokenDisplay();
  }
}
grEl("grMakeBtn").addEventListener("click", grMake);

/* ── 결과 그리기 — 문제 탭의 buildQuizHtml을 그대로 쓴다 ── */
function grSheetName() {
  return grState.title || `${(GRAMMAR_GRADES.find((g) => g.id === grState.grade) || {}).label || ""} 문법 문제`.trim();
}

function grApplyTitle() {
  const res = grEl("grResult");
  const head = res.querySelector(".qz-sheet-title");
  if (head) head.textContent = grSheetName();
  const ab = res.querySelector(".qz-answerbook-head");
  if (ab) ab.textContent = `${grSheetName()} — 정답 및 해설`;
}

function grRender() {
  const res = grEl("grResult");
  const qs = grState.questions.map((q, i) => Object.assign({}, q, { no: i + 1 }));
  if (!qs.length) {
    res.innerHTML = "";
    grSyncButtons();
    return;
  }
  const built = buildQuizHtml({ questions: qs }, { name: "", named: false }, 1, "grammar", "", "", true, 0);
  res.innerHTML =
    `<div class="qz-sheet-title"></div>` + built.html +
    `<section class="qz-answerbook"><h2 class="qz-answerbook-head"></h2>${built.answerHtml}</section>` +
    `<footer class="qz-footer">문법 문제 · 자동 생성</footer>`;
  res.classList.toggle("gr-1col", grState.cols === 1);
  // 문항마다 [✏️ 고치기] — 화면에서만 보인다(인쇄 안 됨). 한 문항만 AI로 다시 만들기는 2026-10-20에 뺐다
  // (한 문항에 값을 따로 매겨야 해 선생님이 납득하기 어려웠다 — 마음에 안 들면 직접 고친다).
  res.querySelectorAll(".qz-card").forEach((card, i) => {
    const bar = document.createElement("div");
    bar.className = "gr-card-tools no-print";
    bar.innerHTML = `<button type="button" class="btn ghost small" data-gr-edit="${i}">✏️ 고치기</button>`;
    card.appendChild(bar);
  });
  grApplyTitle();
  grSyncButtons();
  res.scrollIntoView({ behavior: "smooth", block: "start" });
}

function grSyncButtons() {
  const has = grState.questions.length > 0;
  ["grPrintBtn", "grAnswerPrintBtn", "grSaveBtn"].forEach((id) => { grEl(id).style.display = has ? "inline-flex" : "none"; });
  grEl("grAssignBtn").style.display = has && typeof isClassroomApproved !== "undefined" && isClassroomApproved ? "inline-flex" : "none";
  if (typeof syncFloatPrint === "function") syncFloatPrint();
}
if (typeof QUIZ_ASSIGN_SYNC !== "undefined") QUIZ_ASSIGN_SYNC.push(grSyncButtons);

/* 고치기 — 문항의 칸을 그대로 열어 고친다. 화면 HTML을 직접 고치지 않는 까닭: 저장·반에 시험 내기가
   문항 값(grState.questions)을 쓰므로, 화면만 고치면 둘이 어긋난다. */
function grEdit(i) {
  const q = grState.questions[i];
  if (!q) return;
  const fmt = q.format;
  const field = (key, label, val, rows, note) =>
    `<label class="gr-ed-l">${label}${note ? ` <span class="hint">${note}</span>` : ""}</label>` +
    `<textarea data-k="${key}" rows="${rows}">${esc(val == null ? "" : String(val))}</textarea>`;
  let body = field("instruction", "발문", q.instruction, 2);
  if (fmt === "verb" || fmt === "fill") {
    body += field("passageHtml", "문장", q.passageHtml, 3, fmt === "verb" ? "바꿀 자리는 (원형|정답)" : "빈칸 자리는 (|정답)");
  } else if (fmt === "write" || fmt === "compose") {
    body += field("passageHtml", "우리말", q.passageHtml, 2);
  } else {
    body += field("passageHtml", fmt === "mc" ? "문장 (없으면 비워 둡니다)" : "문장", q.passageHtml, 3, "<u>밑줄</u> <b>굵게</b> <br>줄바꿈");
  }
  if (fmt === "mc") {
    body += field("choices", "보기 (한 줄에 하나, 5줄)", (q.choices || []).join("\n"), 5);
    body += `<label class="gr-ed-l">정답 번호</label><input type="number" min="1" max="5" data-k="answer" value="${q.answer || 1}">`;
  }
  if (fmt === "fix") {
    const f = (q.fixes || [])[0] || {};
    body += field("fixWrong", "틀린 부분 (문장에 그대로 있는 글자)", f.wrong, 1);
    body += field("fixRight", "고친 말", f.right, 1);
  }
  if (fmt === "compose") body += field("wordBank", "<보기> 낱말 (한 줄에 하나)", (q.wordBank || []).join("\n"), 3);
  if (fmt === "compose" || fmt === "convert") body += field("conditions", "<조건> (한 줄에 하나)", (q.conditions || []).join("\n"), 3);
  if (["write", "compose", "convert"].includes(fmt)) {
    body += field("answerText", "정답 문장 (대표 답)", q.answerText, 2);
    body += field("alts", "다른 정답 (한 줄에 하나)", (q.alts || []).join("\n"), 2, "학생이 이렇게 써도 맞음 처리됩니다");
  }
  if (fmt === "verb" || fmt === "fill") {
    body += `<div class="hint" style="margin-top:6px">정답이 둘 이상이면 문장 안 괄호에 <b>/</b>로 이어 적으세요. 예: (|whom / who / that)</div>`;
  }
  if (fmt === "fix") {
    body += `<div class="hint" style="margin-top:6px">고친 말이 둘 이상이면 <b>/</b>로 이어 적으세요. 예: whom / who / that</div>`;
  }
  body += field("explanation", "해설", q.explanation, 3);
  grEl("grEditBody").innerHTML = body;
  grEl("grEditTitle").textContent = `${i + 1}번 문항 고치기`;
  grEl("grEditModal").dataset.i = i;
  grEl("grEditModal").hidden = false;
}

grEl("grEditSave").addEventListener("click", () => {
  const modal = grEl("grEditModal");
  const i = Number(modal.dataset.i);
  const q = Object.assign({}, grState.questions[i]);
  const val = (k) => { const el = modal.querySelector(`[data-k="${k}"]`); return el ? el.value : null; };
  const lines = (k) => String(val(k) || "").split("\n").map((s) => s.trim()).filter(Boolean);
  ["instruction", "passageHtml", "answerText", "explanation"].forEach((k) => { if (val(k) !== null) q[k] = val(k).trim(); });
  if (val("choices") !== null) {
    const c = lines("choices");
    if (c.length < 2) { alert("보기를 두 줄 이상 적어 주세요."); return; }
    q.choices = c.slice(0, 5);
    q.answer = Math.max(1, Math.min(q.choices.length, parseInt(val("answer"), 10) || 1));
  }
  if (val("fixWrong") !== null) {
    if (val("fixWrong").trim() && !q.passageHtml.includes(val("fixWrong").trim())) {
      alert("‘틀린 부분’은 문장에 글자 그대로 있어야 합니다."); return;
    }
    q.fixes = [{ wrong: val("fixWrong").trim(), right: val("fixRight").trim() }];
  }
  if (val("wordBank") !== null) q.wordBank = lines("wordBank");
  if (val("conditions") !== null) q.conditions = lines("conditions");
  if (val("alts") !== null) q.alts = lines("alts").filter((a) => !a.includes("/"));   // 채점이 '/'로 가르므로 문장 안에는 못 쓴다
  if ((q.format === "verb" || q.format === "fill") && !/\([^()|]*\|[^()|]*\)/.test(q.passageHtml)) {
    alert(q.format === "verb" ? "바꿀 자리를 (원형|정답) 모양으로 하나 이상 남겨 주세요." : "빈칸 자리를 (|정답) 모양으로 하나 이상 남겨 주세요.");
    return;
  }
  grState.questions[i] = q;
  modal.hidden = true;
  const y = window.scrollY;
  grRender();
  window.scrollTo(0, y);
});
grEl("grEditCancel").addEventListener("click", () => { grEl("grEditModal").hidden = true; });
grEl("grEditModal").addEventListener("click", (e) => { if (e.target === grEl("grEditModal")) grEl("grEditModal").hidden = true; });

grEl("grResult").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-gr-edit]");
  if (ed) grEdit(Number(ed.dataset.grEdit));
});

/* ── 인쇄·저장·반에 시험 내기 ── */
const grTitleHandle = {
  get: () => grState.title,
  set: (v) => { grState.title = String(v || "").trim(); grEl("grTitle").value = grState.title; grApplyTitle(); },
};
grEl("grPrintBtn").addEventListener("click", () =>
  printDoc(() => `문법문제_${sanitizeFilename(grSheetName())}_${todayStr()}`, { title: grTitleHandle }));
grEl("grAnswerPrintBtn").addEventListener("click", () =>
  printDoc(() => `문법문제_${sanitizeFilename(grSheetName())}_답지_${todayStr()}`, {
    title: grTitleHandle,
    before: () => grEl("grResult").classList.add("answers-only"),
    after: () => grEl("grResult").classList.remove("answers-only"),
  }));
grEl("grSaveBtn").addEventListener("click", () => openSaveDialog("grammar"));
grEl("grAssignBtn").addEventListener("click", () =>
  // gkind(값 셈용)와 옛 저장본의 gitem·gshape는 학생 시험에 싣지 않는다(서버도 버린다).
  // 배열 영작은 looseOrder를 달아 같은 단어·다른 어순이면 틀림 대신 '확인 대기'로 채점되게 한다.
  openQuizAssign(grState.questions.map(({ gitem, gkind, gshape, ...rest }) =>
    rest.format === "write" ? { ...rest, looseOrder: true } : rest), grSheetName(), "quiz"));
grEl("grLoadBtn").addEventListener("click", () => openSavedList("tab", null, "grammar"));

TAB_LABELS.grammar = "📐 문법 문제";
TAB_LIBRARY_WORDS.grammar = {
  title: "📐 문법 문제 저장함",
  lead: "저장해 둔 문법 문제입니다. [불러오기]를 누르면 AI를 다시 부르지 않고 그 시험지를 그대로 엽니다.",
  empty: "아직 저장한 문법 문제가 없습니다. 문제를 만든 뒤 “💾 사이트 저장”을 눌러 보세요.",
};
// 시험지 꾸미기(색·글자 크기·글꼴) — 문제 탭과 같은 한 벌(app.js createSheetStyle). 문항 모양이 같아 "quiz" 묶음을 쓴다
const grSheetStyle = createSheetStyle("grSheetStyle", grEl("grResult"), "quiz");
SAVE_TITLE_SUGGEST.grammar = () => ["문법문제", sanitizeFilename(grSheetName()), todayStr()].filter(Boolean).join("_");
TAB_SAVE.grammar = {
  // saveBtn을 등록하지 않는다 — app.js가 단추를 연결한 뒤에 이 파일이 로드된다(trend.js와 같다)
  canSave: () => (grState.questions.length ? "" : "먼저 문제를 만들어 주세요."),
  saveLead: () => "고른 레벨·문법 항목·문항 수와 만든 문제를 저장합니다. 나중에 [📂 불러오기]로 다시 열어 인쇄·수정할 수 있습니다.",
  getPayload: () => ({
    v: 1,
    settings: {
      grade: grState.grade, picked: grState.picked, mode: grState.mode, split: grState.split,
      mcTotal: grState.mcTotal, saTotal: grState.saTotal, aiPick: grState.aiPick,
      mcShapes: grState.mcShapes, saShapes: grState.saShapes, cols: grState.cols,
    },
    title: grState.title,
    questions: grState.questions,
    sheetStyle: grSheetStyle.get(),
  }),
  applyPayload: (payload) => {
    const s = payload.settings || {};
    if (GRAMMAR_GRADE_IDX[s.grade] !== undefined) grState.grade = s.grade;
    grState.picked = Array.isArray(s.picked) ? s.picked.filter((p) => p && p.name)
      .map((p) => ({ name: String(p.name), mc: p.mc | 0, sa: p.sa | 0 })) : [];
    grState.mode = s.mode === "passage" ? "passage" : "plain";
    grState.split = s.split === "manual" ? "manual" : "auto";
    grState.mcTotal = s.mcTotal | 0; grState.saTotal = s.saTotal | 0;
    grState.aiPick = s.aiPick !== false;
    grState.mcShapes = (s.mcShapes || []).filter((x) => GRAMMAR_MC_SHAPES.some((y) => y.id === x));
    grState.saShapes = (s.saShapes || []).filter((x) => GRAMMAR_SA_SHAPES.some((y) => y.id === x));
    if (!grState.mcShapes.length) grState.mcShapes = GRAMMAR_MC_SHAPES.map((x) => x.id);
    if (!grState.saShapes.length) grState.saShapes = GRAMMAR_SA_SHAPES.map((x) => x.id);
    grState.cols = s.cols === 1 ? 1 : 2;
    grState.title = String(payload.title || "");
    grEl("grTitle").value = grState.title;
    grState.questions = Array.isArray(payload.questions) ? payload.questions : [];
    // 꾸미기가 생기기 전 저장본에는 값이 없다 — 지금 고른 모양을 그대로 둔다
    if (payload.sheetStyle) grSheetStyle.set(payload.sheetStyle);
    grState.topic = null;
    grRenderShapes();
    grRenderAll();
    syncTabChrome("grammar");
    grRender();
  },
  clearResults: () => { grState.questions = []; grRender(); },
};

if (typeof HOWTO !== "undefined") {
  HOWTO.grammar = {
    title: "📐 문법문제 출제 마법사 사용법",
    lead: "레벨과 문법 항목을 고르면 그 문법만 묻는 객관식·주관식 문제를 만듭니다. 지문 없이도 만들 수 있습니다.",
    steps: [
      "맨 위에서 <b>문법만으로</b> / <b>넣은 지문으로</b>를 고르고, <b>① 레벨</b>(초등 고학년 · 중등 Level 1~3 · 수능 Level)을 고릅니다.",
      "<b>② 문법 항목</b>을 누르고 <b>③ 세부 항목</b>을 체크합니다. 체크한 것은 <b>④ 고른 항목</b>에 모입니다.",
      "<b>⑤ 문항 수 · 모양</b>에서 객관식·주관식 문항 수, 문제 모양, 1단/2단을 정합니다. <b>항목마다 직접 정하기</b>를 고르면 ④에서 항목별 개수를 적습니다.",
      "<b>[문제 만들기]</b>를 누릅니다. 마음에 안 드는 문항은 <b>[✏️ 고치기]</b>로 직접 고칩니다.",
      "<b>[🖨️ 인쇄 / PDF 변환]</b> · <b>[🔑 답지만]</b> · <b>[💾 사이트 저장]</b>으로 마무리합니다. <b>🎨 시험지 꾸미기</b>로 색·글자 크기·글꼴을 바꿀 수 있습니다(요금 없음).",
    ],
    tip: "한 번에 50문항까지 만들 수 있습니다. 승인된 선생님은 <b>[🏫 반에 시험 내기]</b>로 학생에게 온라인 시험을 낼 수 있습니다.",
  };
}

grRenderShapes();
grRenderAll();
