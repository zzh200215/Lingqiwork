import json, urllib.request

def post(path, data):
    req = urllib.request.Request(
        "http://127.0.0.1:8000" + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        print(r.status, r.read().decode("utf-8"))

post("/api/prompts", {"title": "翻译成英文", "content": "把下面的内容翻译成英文，保留代码块和专业术语：\n\n{内容}"})
post("/api/prompts", {"title": "周报生成", "content": "根据以下工作要点生成一份结构化周报（本周完成/下周计划/风险）：\n\n{要点}"})
