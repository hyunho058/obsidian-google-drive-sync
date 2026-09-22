import SparkMD5 from "spark-md5";

/**
 * Drive reports `md5Checksum` for every non-Google-native file, which makes MD5
 * the only hash that lets us compare local and remote content without a
 * download. Web Crypto (`crypto.subtle`) offers SHA-* only, so this has to be a
 * JS implementation — spark-md5 is ~5 KB and runs fine inside the iOS WebView.
 */
const CHUNK = 2 * 1024 * 1024;

export function md5(data: ArrayBuffer): string {
  if (data.byteLength <= CHUNK) return SparkMD5.ArrayBuffer.hash(data);
  const spark = new SparkMD5.ArrayBuffer();
  for (let off = 0; off < data.byteLength; off += CHUNK) {
    spark.append(data.slice(off, Math.min(off + CHUNK, data.byteLength)));
  }
  return spark.end();
}
