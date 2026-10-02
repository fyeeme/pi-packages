import { describe, expect, it } from "vitest";
import { collect, filePathCollector, jsonCollector, urlCollector } from "../src/outcomes.ts";

describe("outcome collectors", () => {
	it("urlCollector extracts http(s) URLs", () => {
		expect(urlCollector("see https://a.com/x and http://b.io/y done")).toEqual(["https://a.com/x", "http://b.io/y"]);
		expect(urlCollector("no links here")).toBeUndefined();
	});

	it("filePathCollector extracts paths and filenames, excludes URLs", () => {
		const out = filePathCollector("edit src/index.ts and /etc/hosts and ~/repo/README.md");
		expect(out).toContain("src/index.ts");
		expect(out).toContain("/etc/hosts");
		expect(out).toContain("~/repo/README.md");
		expect(filePathCollector("https://x.com")).toBeUndefined(); // a bare URL has no path/filename match
	});

	it("jsonCollector extracts the first balanced JSON object", () => {
		expect(jsonCollector('noise {"a":1,"b":[2,3]} tail')).toEqual({ a: 1, b: [2, 3] });
		expect(jsonCollector('arr [1, "x", true]')).toEqual([1, "x", true]);
		expect(jsonCollector("no json")).toBeUndefined();
	});

	it("collect dispatches by spec kind", () => {
		expect(collect({ kind: "url" }, "go https://x.io")).toEqual(["https://x.io"]);
		expect(collect<string[]>({ kind: "file_path" }, "see src/a.ts")).toContain("src/a.ts");
		expect(collect({ kind: "json" }, '{"k":"v"}')).toEqual({ k: "v" });
	});

	it("collect honors a custom url pattern", () => {
		expect(collect({ kind: "url", pattern: /ftp:\/\/[^\s]+/g }, "ftp://h/x and https://y")).toEqual(["ftp://h/x"]);
	});
});
