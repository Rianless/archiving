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
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' ' + platformQuery + ' 추천')}&display=20&sort=sim`,
      { headers: naverHeaders }
    );
    const blogData = await blogRes.json();
    const blogItems = blogData.items || [];

    if (!blogItems.length) {
      return res.status(200).json({ results: [] });
    }

    // 2. 블로그 제목+설명에서 작품명 추출
    const extracted = new Map(); // title → { author, platform, description, source }

    for (const item of blogItems) {
      const raw = item.title + ' ' + item.description;
      const text = raw.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ');

      // 패턴 1: [작품명], 「작품명」, 『작품명』
      const bracketMatches = text.matchAll(/[\[「『]([^\]」』]{2,30})[\]」』]/g);
      for (const m of bracketMatches) {
        const title = m[1].trim();
        if (isValidTitle(title) && !extracted.has(title)) {
          extracted.set(title, {
            author: '',
            platform: guessPlatform(text, platform),
            description: item.description.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').slice(0, 80),
            blogLink: item.link,
          });
        }
      }

      // 패턴 2: <제목> 태그 제거 후 남은 꺾쇠 (HTML 이미 제거했으니 남은 건 작품명용)
      const angleMatches = text.matchAll(/<([^>]{2,30})>/g);
      for (const m of angleMatches) {
        const title = m[1].trim();
        if (isValidTitle(title) && !extracted.has(title)) {
          extracted.set(title, {
            author: '',
            platform: guessPlatform(text, platform),
            description: item.description.replace(/<[^>]*>/g, '').slice(0, 80),
            blogLink: item.link,
          });
        }
      }

      // 패턴 3: 블로그 제목 자체가 "작품명 리뷰/추천" 형식일 때
      const blogTitle = item.title.replace(/<[^>]*>/g, '').trim();
      const titleMatch = blogTitle.match(/^(.{2,20}?)\s*(리뷰|추천|후기|소개|완독)/);
      if (titleMatch) {
        const title = titleMatch[1].trim();
        if (isValidTitle(title) && !extracted.has(title)) {
          extracted.set(title, {
            author: '',
            platform: guessPlatform(text, platform),
            description: item.description.replace(/<[^>]*>/g, '').slice(0, 80),
            blogLink: item.link,
          });
        }
      }
    }

    // 추출된 작품이 없으면 블로그 제목들에서 키워드 추출 시도
    if (extracted.size === 0) {
      for (const item of blogItems.slice(0, 5)) {
        const title = item.title.replace(/<[^>]*>/g, '').trim();
        if (title.length > 2 && title.length < 30 && isValidTitle(title)) {
          extracted.set(title, {
            author: '',
            platform: guessPlatform(item.description, platform),
            description: item.description.replace(/<[^>]*>/g, '').slice(0, 80),
            blogLink: item.link,
          });
        }
      }
    }

    const works = Array.from(extracted.entries()).slice(0, 6).map(([title, info]) => ({
      title,
      ...info,
    }));

    if (!works.length) {
      return res.status(200).json({ results: [] });
    }

    // 3. 각 작품 표지 이미지 검색 + 플랫폼 링크 생성
    const results = await Promise.all(
      works.map(async (work) => {
        try {
          const imgRes = await fetch(
            `https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(work.title + ' 웹소설 표지')}&display=1&sort=sim`,
            { headers: naverHeaders }
          );
          const imgData = await imgRes.json();
          const cover = imgData.items?.[0]?.thumbnail || '';

          return {
            title: work.title,
            author: work.author,
            platform: work.platform,
            description: work.description,
            cover,
            platformLink: getPlatformLink(work.title, work.platform),
          };
        } catch {
          return {
            title: work.title,
            author: work.author,
            platform: work.platform,
            description: work.description,
            cover: '',
            platformLink: getPlatformLink(work.title, work.platform),
          };
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
  // 너무 짧거나, 숫자만 있거나, 흔한 키워드면 제외
  if (title.length < 2) return false;
  const stopWords = ['추천', '리뷰', '후기', '소개', '완결', '연재', '웹소설', '로판', '로맨스', '판타지', 'BL', '조아라', '카카오', '네이버', '리디', '1위', '무료', '이벤트', '작가', '작품'];
  if (stopWords.some(w => title === w)) return false;
  if (/^\d+$/.test(title)) return false;
  return true;
}

// 텍스트에서 플랫폼 유추
function guessPlatform(text, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  if (/카카오페이지|카카페/.test(text)) return '카카오페이지';
  if (/네이버시리즈|네시/.test(text)) return '네이버시리즈';
  if (/리디북스|리디/.test(text)) return '리디북스';
  return '조아라'; // 기본값
}

// 플랫폼별 검색 링크
function getPlatformLink(title, platform) {
  const q = encodeURIComponent(title);
  switch (platform) {
    case '카카오페이지': return `https://page.kakao.com/search/result?keyword=${q}`;
    case '네이버시리즈': return `https://series.naver.com/search/search.series?t=novel&q=${q}`;
    case '리디북스':    return `https://ridibooks.com/search?q=${q}`;
    default:            return `https://www.joara.com/search?keyword=${q}`;
  }
}
