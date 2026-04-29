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

  try {
    // 1. 네이버 책 검색 먼저 시도
    const bookRes = await fetch(
      `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(query)}&display=10&sort=sim`,
      { headers: naverHeaders }
    );
    const bookData = await bookRes.json();
    const bookItems = (bookData.items || []).filter(item => {
      // 웹소설 관련 출판사만 (너무 엉뚱한 책 필터링)
      const pub = clean(item.publisher).toLowerCase();
      const desc = clean(item.description).toLowerCase();
      const title = clean(item.title).toLowerCase();
      // 웹소설 관련 키워드가 하나라도 있으면 포함
      const webnovelKeywords = ['카카오', '네이버', '리디', '조아라', '로맨스', '판타지', '웹소설', '웹툰', '문피아', '시리즈'];
      return webnovelKeywords.some(k => pub.includes(k) || desc.includes(k) || title.includes(k));
    });

    if (bookItems.length >= 3) {
      // 책 결과 충분하면 책 결과 반환
      const results = bookItems.slice(0, 6).map(item => ({
        type: 'book',
        title: clean(item.title),
        author: clean(item.author).replace(/\^/g, ', '),
        platform: guessPlatform(clean(item.publisher), platform),
        description: clean(item.description).slice(0, 200),
        cover: item.image || '',
        publisher: clean(item.publisher),
        pubdate: item.pubdate || '',
      }));
      return res.status(200).json({ results });
    }

    // 2. 책 결과 부족하면 블로그 검색으로 fallback
    const platformQuery = platform && platform !== '전체' ? platform : '웹소설';
    const blogRes = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' ' + platformQuery + ' 추천')}&display=10&sort=sim`,
      { headers: naverHeaders }
    );
    const blogData = await blogRes.json();
    const blogItems = blogData.items || [];

    if (!blogItems.length) {
      return res.status(200).json({ results: [] });
    }

    // 블로그 글 자체를 카드로 보여줌 (작품명 추출 없이)
    const results = blogItems.slice(0, 6).map(item => ({
      type: 'blog',
      title: clean(item.title),
      author: item.bloggername || '',
      platform: guessPlatformFromText(clean(item.title) + ' ' + clean(item.description), platform),
      description: clean(item.description).slice(0, 200),
      cover: '',
      link: item.link || '',
      bloggerlink: item.bloggerlink || '',
    }));

    res.status(200).json({ results });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function guessPlatform(publisher, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  const p = publisher.toLowerCase();
  if (/카카오|kakao/.test(p)) return '카카오페이지';
  if (/네이버|naver|시리즈/.test(p)) return '네이버시리즈';
  if (/리디|ridi/.test(p)) return '리디북스';
  if (/조아라/.test(p)) return '조아라';
  if (/문피아/.test(p)) return '문피아';
  return '웹소설';
}

function guessPlatformFromText(text, preferPlatform) {
  if (preferPlatform && preferPlatform !== '전체') return preferPlatform;
  if (/카카오페이지|카카페/.test(text)) return '카카오페이지';
  if (/네이버시리즈|네시/.test(text)) return '네이버시리즈';
  if (/리디북스|리디/.test(text)) return '리디북스';
  if (/조아라/.test(text)) return '조아라';
  return '웹소설';
}
