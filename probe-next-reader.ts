import axios from "axios";

const urls = [
  "https://www.next.ae/en/style/su759706/w59264",
  "https://www.next.ae/en/style/sv124809/g44412",
  "https://www.next.co.uk/style/su759706/w59264",
  "https://www.next.co.uk/style/sv124809/g44412",
];

async function tryReader(target: string) {
  const r = await axios.get(`https://r.jina.ai/${target}`, {
    headers: { Accept: "text/plain", "User-Agent": "Mozilla/5.0" },
    timeout: 45000,
    validateStatus: () => true,
  });
  const text = String(r.data);
  return { status: r.status, len: text.length, hasAed: /AED|د\.?إ/i.test(text), hasTitle: /#\s+\w/.test(text), preview: text.slice(0, 600) };
}

async function main() {
  for (const url of urls) {
    console.log("\n===", url, "===");
    try {
      console.log(await tryReader(url));
    } catch (e: any) {
      console.log("err", e.message);
    }
  }
}

main();
