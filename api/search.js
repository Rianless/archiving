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

  const getImage = async (title) => {
    try {
      const r = await fetch(
        `https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(title + ' 웹소설')}&display=1&sort=sim`,
        { headers: naverHeaders }
      );
      const d = await r.json();
      return d.items?.[0]?.thumbnail || '';
    } catch { return ''; }
  };

  try {
    // 1. 네이버 책 검색
    const bookRes = await fetch(
      `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(query)}&display=10&sort=sim`,
      { headers: naverHeaders }
    );
    const bookData = await bookRes.json();
    const bookItems = (bookData.items || []).filter(item => {
      const pub = clean(item.publisher).toLowerCase();
      const desc = clean(item.description).toLowerCase();
      const title = clean(item.title).toLowerCase();
      const webnovelKeywords = ['카카오', '네이버', '리디', '조아라', '로맨스', '판타지', '웹소설', '문피아', '시리즈'];
      return webnovelKeywords.some(k => pub.includes(k) || desc.includes(k) || title.includes(k));
    });

    if (bookItems.length >= 3) {
      const results = await Promise.all(bookItems.slice(0, 6).map(async item => {
        const title = clean(item.title);
        const cover = item.image || await getImage(title);
        return {
          type: 'book',
          title,
          author: clean(item.author).replace(/\^/g, ', '),
          platform: guessPlatform(clean(item.publisher), platform),
          description: clean(item.description).slice(0, 200),
          cover,
          publisher: clean(item.publisher),
          pubdate: item.pubdate || '',
          link: item.link || '',
        };
      }));
      return res.status(200).json({ results });
    }

    // 2. 블로그 fallback
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

    // 블로그 타입도 이미지 검색 + 팝업으로 보여줌
    const results = await Promise.all(blogItems.slice(0, 6).map(async item => {
      const title = clean(item.title);
      // 블로그 제목에서 [] 안 텍스트 추출 시도 (작품명일 가능성 높음)
      const bracketMatch = title.match(/[\[「『]([^\]」』]{2,20})[\]」』]/);
      const displayTitle = bracketMatch ? bracketMatch[1] : title;
      const cover = await getImage(displayTitle);

      return {
        type: 'blog',
        title: displayTitle,
        originalTitle: title,
        author: item.bloggername || '',
        platform: guessPlatformFromText(title + ' ' + clean(item.description), platform),
        description: clean(item.description).slice(0, 200),
        cover,
        link: item.link || '',
        pubdate: (item.postdate || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3'),
      };
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
