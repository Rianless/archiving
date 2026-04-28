export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  try {
    // 블로그 검색
    const blogRes = await fetch(
      `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query + ' 웹소설 리뷰')}&display=5&sort=sim`,
      {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        }
      }
    );
    const blogData = await blogRes.json();

    // 웹문서 검색
    const webRes = await fetch(
      `https://openapi.naver.com/v1/search/webkr.json?query=${encodeURIComponent(query + ' 웹소설 추천')}&display=5&sort=sim`,
      {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        }
      }
    );
    const webData = await webRes.json();

    res.status(200).json({
      blog: blogData.items || [],
      web: webData.items || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
