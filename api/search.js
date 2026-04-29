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
    // 1. 네이버 블로그 검색
    const blogRes = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' ' + platformQuery + ' 추천')}&display=10&sort=sim`,
      { headers: naverHeaders }
    );
    const blogData = await blogRes.json();
    const blogItems = (blogData.items || []).slice(0, 5);

    if (!blogItems.length) {
      return res.status(200).json({ results: [] });
    }

    // 2. 블로그 본문 fetch해서 작품 제목 추출
    const extracted = new Map(); // 중복 제거

    await Promise.all(blogItems.map(async (item) => {
      try {
        // 네이버 블로그는 모바일 URL로 fetch하면 본문 텍스트 얻기 쉬움
        const postUrl = item.link.replace('blog.naver.com', 'blog.naver.com/PostView.naver')
          .replace('blog.naver.com/PostView.naver', 'blog.naver.com');

        // 모바일 버전으로 변환
        const mobileUrl = item.link
          .replace('https://blog.naver.com/', 'https://m.blog.naver.com/')
          .replace('http://blog.naver.com/', 'https://m.blog.naver.com/');

        const pageRes = await fetch(mobileUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(5000),
        });

        const html = await pageRes.text();

        // HTML 태그 제거해서 텍스트만 추출
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();

        const titles = extractTitles(text, platform);
        const guessedPlatform = guessPlatform(text, platform);

        titles.forEach(t => {
          if (!extracted.has(t.title)) {
            extracted.set(t.title, {
              author: t.author || '',
              platform: guessedPlatform,
              description: t.context || '',
            });
          }
        });

      } catch {
        // 개별 블로그 fetch 실패는 무시
      }
    }));

    // 본문에서 못 뽑으면 snippet에서라도 시도
    if (extracted.size === 0) {
      for (const item of blogItems) {
        const text = (item.title + ' ' + item.description).replace(/<[^>]*>/g, '');
        const titles = extractTitles(text, platform);
        titles.forEach(t => {
          if (!extracted.has(t.title)) {
            extracted.set(t.title, {
              author: t.author || '',
              platform: guessPlatform(text, platform),
              description: t.context || '',
            });
          }
        });
      }
    }

    const works = Array.from(extracted.entries()).slice(0, 6).map(([title, info]) => ({
      title,
      ...info,
    }));

    if (!works.length) {
      return res.status(200).json({ results: [] });
    }

    // 3. 표지 이미지 검색
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

// 본문 텍스트에서 작품 제목 추출
function extractTitles(text, platform) {
  const results = [];
  const seen = new Set();

  const add = (title, author = '', context = '') => {
    title = title.trim().replace(/[『』「」\[\]【】《》<>'"]/g, '').trim();
    if (!isValidTitle(title) || seen.has(title)) return;
    seen.add(title);
    results.push({ title, author, context: context.trim().slice(0, 100) });
  };

  // 패턴 1: 제목: XXX / 작품명: XXX / 소설명: XXX
  for (const m of text.matchAll(/(?:제목|작품명|소설명|작품)\s*[:：]\s*([^\n,、。/]{2,25})/g)) {
    add(m[1], '', text.slice(Math.max(0, m.index - 50), m.index + 80));
  }

  // 패턴 2: 작가 정보와 함께 나오는 경우: XXX / 작가명 or XXX - 작가명
  for (const m of text.matchAll(/([가-힣a-zA-Z\s]{2,20})\s*[\/\-]\s*([가-힣]{2,6})\s*작가/g)) {
    add(m[1].trim(), m[2].trim() + ' 작가', '');
  }

  // 패턴 3: 순위형 - "1. 작품명", "1위 작품명"
  for (const m of text.matchAll(/(?:^|\n|\s)(?:\d+\s*[\.위\)]\s*)([가-힣a-zA-Z][가-힣a-zA-Z\s!?…]{1,25})/gm)) {
    const candidate = m[1].trim();
    // 다음 문장에서 작가 찾기
    const after = text.slice(m.index, m.index + 150);
    const authorMatch = after.match(/작가\s*[:：]?\s*([가-힣]{2,6})/);
    add(candidate, authorMatch ? authorMatch[1] : '', after.slice(0, 100));
  }

  // 패턴 4: 따옴표/괄호로 감싼 제목
  for (const m of text.matchAll(/[『「《【<\["]([가-힣a-zA-Z][가-힣a-zA-Z0-9\s\-!?~…,]{1,25})[』」》】>\]"]/g)) {
    add(m[1], '', text.slice(Math.max(0, m.index - 30), m.index + 80));
  }

  // 패턴 5: "XXX 추천", "XXX 완독", "XXX 정주행" 앞의 단어
  for (const m of text.matchAll(/([가-힣a-zA-Z][가-힣a-zA-Z0-9\s]{1,20})\s+(?:추천|완독|정주행|소개|리뷰)/g)) {
    add(m[1].trim(), '', '');
  }

  return results;
}

// 유효한 작품 제목인지 검증
function isValidTitle(title) {
  if (!title || title.length < 2 || title.length > 30) return false;
  const stopWords = [
    '추천', '리뷰', '후기', '소개', '완결', '연재', '웹소설', '로판', '로맨스',
    '판타지', 'BL', '조아라', '카카오', '네이버', '리디', '무료', '이벤트',
    '작가', '작품', '오늘', '이번', '정말', '너무', '진짜', '완전', '읽기',
    '보기', '시작', '드디어', '결국', '여기', '이렇게', '그래서', '하지만',
  ];
  if (stopWords.some(w => title === w || title.endsWith(w))) return false;
  if (/^\d+$/.test(title)) return false;
  if (/^[a-zA-Z\s]+$/.test(title) && title.length < 4) return false;
  return true;
}

// 텍스트에서 플랫폼 유추
function guessPlatform(text, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  if (/카카오페이지|카카페/.test(text)) return '카카오페이지';
  if (/네이버시리즈|네시/.test(text)) return '네이버시리즈';
  if (/리디북스|리디/.test(text)) return '리디북스';
  return '조아라';
}
