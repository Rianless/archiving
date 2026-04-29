export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { query, platform } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const naverHeaders = {
    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
  };

  try {
    // 네이버 책 검색 API
    const bookRes = await fetch(
      `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(query)}&display=10&sort=sim`,
      { headers: naverHeaders }
    );
    const bookData = await bookRes.json();
    const items = bookData.items || [];

    if (!items.length) {
      return res.status(200).json({ results: [], message: '검색 결과가 없습니다.' });
    }

    // 플랫폼 필터 적용
    const filtered = platform && platform !== '전체'
      ? items.filter(item => {
          const pub = (item.publisher || '').toLowerCase();
          const platformMap = {
            '조아라': ['조아라'],
            '카카오페이지': ['카카오', 'kakao'],
            '네이버시리즈': ['네이버', 'naver', '시리즈'],
            '리디북스': ['리디', 'ridi'],
          };
          const keywords = platformMap[platform] || [];
          return keywords.some(k => pub.includes(k));
        })
      : items;

    // 결과가 없으면 필터 없이 전체 반환
    const finalItems = filtered.length ? filtered : items;

    const results = finalItems.slice(0, 6).map(item => {
      // 출판사로 플랫폼 추측
      const pub = item.publisher || '';
      let guessedPlatform = platform && platform !== '전체' ? platform : guessPlatform(pub);

      // HTML 태그 제거
      const clean = (str) => (str || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim();

      return {
        title: clean(item.title),
        author: clean(item.author).replace(/\^/g, ', '),
        platform: guessedPlatform,
        description: clean(item.description).slice(0, 200),
        cover: item.image || '',
        isbn: item.isbn || '',
        pubdate: item.pubdate || '',
        publisher: clean(item.publisher),
      };
    });

    res.status(200).json({ results });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function guessPlatform(publisher) {
  const p = publisher.toLowerCase();
  if (/카카오|kakao/.test(p)) return '카카오페이지';
  if (/네이버|naver|시리즈/.test(p)) return '네이버시리즈';
  if (/리디|ridi/.test(p)) return '리디북스';
  if (/조아라/.test(p)) return '조아라';
  return '웹소설';
}
