export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { query, platform } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const naverHeaders = {
    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
  };

  const clean = (str) =>
    (str || '').replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, ' ').trim();

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ko-KR,ko;q=0.9',
  };

  try {
    // 1. 블로그 검색
    const platformQuery = platform && platform !== '전체' ? platform : '웹소설';
    const blogRes = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' ' + platformQuery + ' 추천')}&display=5&sort=sim`,
      { headers: naverHeaders }
    );
    const blogData = await blogRes.json();
    const blogItems = blogData.items || [];

    if (!blogItems.length) {
      return res.status(200).json({ results: [] });
    }

    // 2. 각 블로그 본문 fetch
    const works = new Map();

    for (const item of blogItems) {
      try {
        // 네이버 블로그 본문 URL 변환
        // https://blog.naver.com/id/postNo → PostView.nhn?blogId=id&logNo=postNo
        let fetchUrl = item.link;

        // 네이버 블로그인 경우 API 형식으로 변환
        const naverBlogMatch = item.link.match(/blog\.naver\.com\/([^/]+)\/(\d+)/);
        if (naverBlogMatch) {
          const blogId = naverBlogMatch[1];
          const logNo = naverBlogMatch[2];
          fetchUrl = `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}&isHttpsRedirect=true`;
        }

        const pageRes = await fetch(fetchUrl, {
          headers: browserHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(6000),
        });

        if (!pageRes.ok) continue;

        const html = await pageRes.text();

        // 본문 텍스트 추출 — 스크립트/스타일 제거 후 태그 제거
        const bodyText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, '\n')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // 본문에서 작품 정보 추출
        const extracted = extractWorks(bodyText, platform);
        for (const w of extracted) {
          if (!works.has(w.title)) {
            works.set(w.title, w);
          }
        }

        if (works.size >= 6) break;

      } catch {
        continue;
      }
    }

    if (works.size === 0) {
      return res.status(200).json({ results: [], message: '작품 정보를 찾지 못했습니다.' });
    }

    // 3. 표지 이미지 검색
    const results = await Promise.all(
      Array.from(works.values()).slice(0, 6).map(async (work) => {
        try {
          const imgRes = await fetch(
            `https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(work.title + ' 웹소설')}&display=1&sort=sim`,
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

function extractWorks(text, platform) {
  const results = [];
  const seen = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const addWork = (title, author, description, ctx) => {
    title = title.trim()
      .replace(/^[\[「『《<]+|[\]」』》>]+$/g, '')
      .trim();
    if (!isValidTitle(title) || seen.has(title)) return;
    seen.add(title);
    results.push({
      type: 'work',
      title,
      author: author.trim(),
      platform: guessPlatformFromText(ctx, platform),
      description: description.trim().slice(0, 200),
      cover: '',
    });
  };

  // 전체 텍스트를 슬라이딩 윈도우로 분석
  const fullText = lines.join('\n');

  // 패턴 1: "제목 : XXX\n작가 : YYY" 형식
  const titleAuthorRe = /제목\s*[:：]\s*(.{2,30})\n.*?작가\s*[:：]\s*(.{2,20})/g;
  for (const m of fullText.matchAll(titleAuthorRe)) {
    const title = m[1].trim();
    const author = m[2].trim();
    const idx = m.index;
    const desc = fullText.slice(idx, idx + 300).split('\n').slice(3, 8).join(' ');
    addWork(title, author, desc, fullText.slice(idx, idx + 500));
  }

  // 패턴 2: 괄호 안 제목 + 바로 뒤 작가/소개
  const bracketRe = /[「『《\[【]([^」』》\]】]{2,25})[」』》\]】]\s*\n?\s*(?:작가|저자)?\s*[:／/]?\s*([가-힣a-zA-Z]{2,10})/g;
  for (const m of fullText.matchAll(bracketRe)) {
    const title = m[1].trim();
    const author = m[2].trim();
    const idx = m.index;
    const desc = fullText.slice(idx + m[0].length, idx + m[0].length + 200);
    addWork(title, author, desc, fullText.slice(Math.max(0, idx - 50), idx + 400));
  }

  // 패턴 3: 숫자 순위형 리스트 "1. 작품명" + 그 다음 줄 작가/소개
  for (let i = 0; i < lines.length - 2; i++) {
    const rankMatch = lines[i].match(/^(?:\d+[\.위\)])\s*(.{2,25})$/);
    if (!rankMatch) continue;

    const title = rankMatch[1].trim();
    if (!isValidTitle(title)) continue;

    // 이후 5줄에서 작가/소개 찾기
    const nextLines = lines.slice(i + 1, i + 6).join('\n');
    const authorMatch = nextLines.match(/(?:작가|저자)\s*[:：]?\s*([가-힣a-zA-Z]{2,10})/);
    const author = authorMatch ? authorMatch[1] : '';
    const desc = nextLines.replace(/(?:작가|저자)[^\n]*/g, '').trim().slice(0, 200);

    addWork(title, author, desc, lines.slice(i, i + 8).join('\n'));
  }

  // 패턴 4: "작품명 / 작가명" 형식
  const slashRe = /([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s~!?]{1,22})\s*[\/]\s*([가-힣]{2,8})\s*(?:작가)?(?:\n|$)/g;
  for (const m of fullText.matchAll(slashRe)) {
    const title = m[1].trim();
    const author = m[2].trim();
    if (!isValidTitle(title)) continue;
    const idx = m.index;
    const desc = fullText.slice(idx + m[0].length, idx + m[0].length + 200);
    addWork(title, author, desc, fullText.slice(Math.max(0, idx - 30), idx + 300));
  }

  return results;
}

function isValidTitle(title) {
  if (!title || title.length < 2 || title.length > 30) return false;
  const stopWords = [
    '추천', '리뷰', '후기', '소개', '완결', '연재', '웹소설', '로판', '로맨스',
    '판타지', 'BL', '조아라', '카카오', '네이버', '리디', '무료', '이벤트',
    '작가', '작품', '오늘', '이번', '정말', '너무', '진짜', '완전',
    '보기', '시작', '드디어', '결국', '여기', '이렇게', '그래서', '하지만',
    '읽기', '읽고', '보고', '제목', '작가명', '줄거리', '내용',
  ];
  if (stopWords.includes(title)) return false;
  if (/^\d+$/.test(title)) return false;
  if (/^\d+[위번편화]$/.test(title)) return false;
  return true;
}

function guessPlatformFromText(text, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  if (/카카오페이지|카카페/.test(text)) return '카카오페이지';
  if (/네이버시리즈|네시/.test(text)) return '네이버시리즈';
  if (/리디북스|리디/.test(text)) return '리디북스';
  if (/조아라/.test(text)) return '조아라';
  return '웹소설';
}
