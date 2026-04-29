export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { query, platform } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const naverHeaders = {
    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
  };

  const platformQuery = platform && platform !== '전체' ? platform : '웹소설';

  try {
    // 1. 네이버 블로그 검색 (많이 긁어서 작품명 추출 확률 높이기)
    const blogRes = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' ' + platformQuery + ' 추천')}&display=20&sort=sim`,
      { headers: naverHeaders }
    );
    const blogData = await blogRes.json();
    const blogItems = blogData.items || [];

    if (!blogItems.length) {
      return res.status(200).json({ results: [] });
    }

    // 2. snippet에서만 작품명 추출 (블로그 제목은 절대 작품명으로 쓰지 않음)
    const extracted = new Map();

    for (const item of blogItems) {
      // description(snippet)만 사용. title은 블로그 글 제목이라 작품명 아님
      const snippet = item.description
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim();

      const guessedPlatform = guessPlatform(snippet + item.title, platform);

      // 패턴 1: 꺾쇠/따옴표 안의 제목 — 가장 신뢰도 높음
      // [제목], 「제목」, 『제목』, <제목>, 《제목》
      const bracketRe = /[[\u300A\u300B\u300C\u300D\u300E\u300F\u00AB\u00BB\u3010\u3011]([^\]】》\u300B\u300D\u300F\u00BB]{2,25})[\]\u300B\u300D\u300F\u00BB\u3011]/g;
      for (const m of snippet.matchAll(/[\[「『《【<]([^\]」』》】>]{2,25})[\]」』》】>]/g)) {
        const t = m[1].trim();
        if (isValidTitle(t) && !extracted.has(t)) {
          extracted.set(t, {
            author: extractAuthor(snippet, t),
            platform: guessedPlatform,
            description: extractContext(snippet, t),
          });
        }
      }

      // 패턴 2: "제목 / 작가" 형식
      for (const m of snippet.matchAll(/([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s\-~!?]{1,22})\s*\/\s*([가-힣]{2,6})\s*(?:작가|저자)?/g)) {
        const t = m[1].trim();
        const a = m[2].trim();
        if (isValidTitle(t) && !extracted.has(t)) {
          extracted.set(t, {
            author: a,
            platform: guessedPlatform,
            description: extractContext(snippet, t),
          });
        }
      }

      // 패턴 3: "제목: XXX" 또는 "작품명: XXX"
      for (const m of snippet.matchAll(/(?:제목|작품명|소설명)\s*[:：]\s*([^\n,。/]{2,25})/g)) {
        const t = m[1].trim();
        if (isValidTitle(t) && !extracted.has(t)) {
          extracted.set(t, {
            author: extractAuthor(snippet, t),
            platform: guessedPlatform,
            description: extractContext(snippet, t),
          });
        }
      }
    }

    // 3. 그래도 없으면 — 블로그 제목에서 [] 안만 뽑기 (최후 수단)
    if (extracted.size === 0) {
      for (const item of blogItems) {
        const blogTitle = item.title.replace(/<[^>]*>/g, '');
        for (const m of blogTitle.matchAll(/[\[「『]([^\]」』]{2,20})[\]」』]/g)) {
          const t = m[1].trim();
          if (isValidTitle(t) && !extracted.has(t)) {
            extracted.set(t, {
              author: '',
              platform: guessPlatform(item.description + blogTitle, platform),
              description: item.description.replace(/<[^>]*>/g, '').slice(0, 100),
            });
          }
        }
      }
    }

    const works = Array.from(extracted.entries()).slice(0, 6).map(([title, info]) => ({
      title,
      ...info,
    }));

    if (!works.length) {
      return res.status(200).json({ results: [], message: '작품명을 찾지 못했습니다. 다른 키워드로 검색해보세요.' });
    }

    // 4. 표지 이미지 검색
    const results = await Promise.all(
      works.map(async (work) => {
        try {
          const imgRes = await fetch(
            `https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(work.title + ' 웹소설 표지')}&display=1&sort=sim`,
            { headers: naverHeaders }
          );
          const imgData = await imgRes.json();
          const cover = imgData.items?.[0]?.thumbnail || '';
          return { ...work, cover };
        } catch {
          return { ...work, cover: '' };
        }
      })
    );

    res.status(200).json({ results });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// 유효한 작품 제목인지 검증
function isValidTitle(title) {
  if (!title || title.length < 2 || title.length > 30) return false;

  // 불용어 — 이 단어 자체거나 이 단어로 끝나면 제외
  const stopWords = [
    '추천', '리뷰', '후기', '소개', '완결', '연재', '웹소설', '로판', '로맨스',
    '판타지', 'BL', '조아라', '카카오', '네이버', '리디', '무료', '이벤트',
    '작가', '작품', '오늘', '이번', '정말', '너무', '진짜', '완전',
    '보기', '시작', '드디어', '결국', '여기', '이렇게', '그래서', '하지만',
    '읽기', '읽고', '보고', '찾고', '찾는', '있는', '없는', '하는',
    '달달한', '귀여운', '재미있는', '육아물', '헌터물',
  ];
  if (stopWords.some(w => title === w)) return false;
  if (/^\d+$/.test(title)) return false;
  // 숫자+위/번/편 으로만 이루어진 거 제외 (ex: "1위", "2번")
  if (/^\d+[위번편]$/.test(title)) return false;
  // 너무 일반적인 형용사+명사 조합 제외
  if (/^(달달|귀여운|재미있는|추천하는|무료)/.test(title)) return false;

  return true;
}

// 텍스트에서 해당 제목 주변 문맥 추출 (작품 소개로 사용)
function extractContext(text, title) {
  const idx = text.indexOf(title);
  if (idx === -1) return text.slice(0, 100);
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + title.length + 120);
  return text.slice(start, end).trim();
}

// 텍스트에서 작가명 추출
function extractAuthor(text, title) {
  const idx = text.indexOf(title);
  if (idx === -1) return '';
  const after = text.slice(idx + title.length, idx + title.length + 50);
  const m = after.match(/작가\s*[:：]?\s*([가-힣]{2,6})|\/\s*([가-힣]{2,6})/);
  if (m) return (m[1] || m[2] || '').trim();
  return '';
}

// 텍스트에서 플랫폼 유추
function guessPlatform(text, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  if (/카카오페이지|카카페/.test(text)) return '카카오페이지';
  if (/네이버시리즈|네시/.test(text)) return '네이버시리즈';
  if (/리디북스|리디/.test(text)) return '리디북스';
  return '조아라';
}
