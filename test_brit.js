const https = require("https");

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        },
      )
      .on("error", reject);
  });
}

async function test() {
  const query = "Bob Dylan";
  const searchHtml = await fetchText(
    `https://www.britannica.com/search?query=${encodeURIComponent(query)}`,
  );

  const linkRegex =
    /<a[^>]*class="font-weight-bold font-18"[^>]*href="([^"]+)"/i;
  const match = searchHtml.match(linkRegex);

  if (match) {
    console.log("Found URL:", match[1]);
    const articleUrl = "https://www.britannica.com" + match[1];
    const articleHtml = await fetchText(articleUrl);

    const pRegex = /<p[^>]*>(.*?)<\/p>/gi;
    let pMatch;
    let paragraphs = [];
    while (
      (pMatch = pRegex.exec(articleHtml)) !== null &&
      paragraphs.length < 3
    ) {
      let text = pMatch[1].replace(/<[^>]+>/g, "").trim();
      text = text.replace(/&#x2013;/g, "-").replace(/&amp;/g, "&");
      if (text.length > 50) paragraphs.push(text);
    }
    console.log("Paragraphs:", paragraphs.join("\n\n"));
  } else {
    console.log("No article found.");
  }
}
test();
