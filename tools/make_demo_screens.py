"""Generate the bundled SAMPLE screenshots for LabPilot's Demo Mode.

These are clean mock images (terminal + generic cloud-console style), every one
stamped "SAMPLE". They imitate what a student captures during an AWS EC2/S3 lab.
No real account, instance or bucket is shown. Run: python3 tools/make_demo_screens.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "demo", "screenshots")
os.makedirs(OUT, exist_ok=True)
W, H = 1280, 720
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
f = lambda p, s: ImageFont.truetype(p, s)

GREEN, BLUE, WHITE, GREY, YEL, RED = "#4ae35b", "#5aa9ff", "#e6e6e6", "#9aa0a6", "#f2c94c", "#ff6b6b"
PROMPT_USER = "ec2-user@ip-172-31-38-14"


def stamp(d):
    d.rounded_rectangle([W - 150, 14, W - 16, 48], 8, fill="#ff4d6d")
    d.text((W - 136, 19), "SAMPLE", font=f(SANS_B, 20), fill="white")


def terminal(name, lines):
    """lines: list of (text, colour) or list of segments [(text, colour), ...]."""
    im = Image.new("RGB", (W, H), "#0c0c0c")
    d = ImageDraw.Draw(im)
    font = f(MONO, 19)
    y = 22
    for ln in lines:
        segs = ln if isinstance(ln, list) else [ln]
        x = 22
        for text, col in segs:
            d.text((x, y), text, font=font, fill=col)
            x += d.textlength(text, font=font)
        y += 27
    stamp(d)
    im.save(os.path.join(OUT, name))


def prompt(cmd, host=PROMPT_USER, path="~"):
    return [(f"[{host} {path}]$ ", GREEN), (cmd, WHITE)]


def console(name, crumb, title, body_fn):
    im = Image.new("RGB", (W, H), "#f2f3f3")
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 56], fill="#16191f")
    d.text((22, 15), "Cloud Console", font=f(SANS_B, 22), fill="white")
    d.text((210, 19), "(sample mock UI)", font=f(SANS, 16), fill="#aab7c4")
    d.text((W - 560, 19), "Region: Asia Pacific (Mumbai) ap-south-1", font=f(SANS, 15), fill="#d5dbdb")
    d.text((24, 72), crumb, font=f(SANS, 16), fill="#0972d3")
    d.text((24, 100), title, font=f(SANS_B, 28), fill="#16191f")
    d.rectangle([24, 150, W - 24, H - 24], fill="white", outline="#d5dbdb")
    body_fn(d)
    stamp(d)
    im.save(os.path.join(OUT, name))


def kv(d, x, y, k, v, vcol="#16191f"):
    d.text((x, y), k, font=f(SANS, 15), fill="#5f6b7a")
    d.text((x, y + 22), v, font=f(SANS_B, 18), fill=vcol)


def table(d, x, y, headers, rows, widths):
    d.rectangle([x, y, x + sum(widths), y + 40], fill="#fafafa")
    cx = x
    for h, w in zip(headers, widths):
        d.text((cx + 12, y + 10), h, font=f(SANS_B, 15), fill="#414d5c")
        cx += w
    for r, row in enumerate(rows):
        ry = y + 40 + r * 44
        d.line([x, ry, x + sum(widths), ry], fill="#e9ebed")
        cx = x
        for cell, w in zip(row, widths):
            col = "#037f0c" if cell in ("Running", "Enabled", "Succeeded") else "#16191f"
            text = ("● " + cell) if cell == "Running" else cell
            d.text((cx + 12, ry + 12), text, font=f(SANS, 16), fill=col)
            cx += w


# ---- Step 2: launch summary (console)
def s2(d):
    d.rectangle([44, 170, W - 44, 220], fill="#f2fcf3", outline="#037f0c")
    d.text((64, 183), "Success  Successfully initiated launch of instance (i-0a1b2c3d4e5f67890)", font=f(SANS_B, 18), fill="#037f0c")
    kv(d, 64, 250, "Name", "vu-cc-lab4-web")
    kv(d, 420, 250, "AMI", "Amazon Linux 2023 AMI (al2023-ami-2023.6)")
    kv(d, 64, 330, "Instance type", "t2.micro")
    kv(d, 420, 330, "Key pair", "lab4-key (RSA, .pem)")
    kv(d, 64, 410, "Security group", "launch-wizard-1 (new)")
    kv(d, 420, 410, "Storage", "1 x 8 GiB gp3")
    kv(d, 64, 490, "Number of instances", "1")
console("IMG_20261014_101532.png", "EC2 > Instances > Launch an instance", "Launch an instance", s2)


# ---- Step 3: security group inbound rules
def s3(d):
    d.text((44, 170), "Security group: sg-04c2b1a9e7f3d1122 - launch-wizard-1", font=f(SANS_B, 18), fill="#16191f")
    d.text((44, 205), "Inbound rules (2)", font=f(SANS_B, 18), fill="#16191f")
    table(d, 44, 240, ["Type", "Protocol", "Port range", "Source", "Description"],
          [["SSH", "TCP", "22", "0.0.0.0/0", "SSH for lab"], ["HTTP", "TCP", "80", "0.0.0.0/0", "Web traffic"]],
          [180, 160, 170, 260, 300])
console("Screenshot (47).png", "EC2 > Security Groups > sg-04c2b1a9e7f3d1122", "Inbound rules", s3)


# ---- Step 4: instances running
def s4(d):
    table(d, 44, 175, ["Name", "Instance ID", "Instance state", "Instance type", "Public IPv4 address"],
          [["vu-cc-lab4-web", "i-0a1b2c3d4e5f67890", "Running", "t2.micro", "13.233.45.112"]],
          [220, 260, 200, 180, 260])
    d.text((44, 300), "Status checks: 2/2 checks passed", font=f(SANS, 17), fill="#037f0c")
    kv(d, 44, 350, "Availability Zone", "ap-south-1a")
    kv(d, 420, 350, "Private IPv4", "172.31.38.14")
console("IMG_20261014_102210.png", "EC2 > Instances", "Instances (1)", s4)


# ---- Step 5: SSH connect (terminal)
terminal("WhatsApp Image 2026-10-14 at 10.24.05.png", [
    [("admin1@DESKTOP-66GTQQD:~$ ", GREEN), ("chmod 400 lab4-key.pem", WHITE)],
    [("admin1@DESKTOP-66GTQQD:~$ ", GREEN), ("ssh -i lab4-key.pem ec2-user@13.233.45.112", WHITE)],
    ("The authenticity of host '13.233.45.112 (13.233.45.112)' can't be established.", WHITE),
    ("ED25519 key fingerprint is SHA256:Qm3x9sV1kPz0yB2cD4eF6gH8iJ0kL2mN4oP6qR8sT0u.", WHITE),
    ("Are you sure you want to continue connecting (yes/no/[fingerprint])? yes", WHITE),
    ("Warning: Permanently added '13.233.45.112' (ED25519) to the list of known hosts.", YEL),
    ("   ,     #_", WHITE), ("   ~\\_  ####_        Amazon Linux 2023", WHITE),
    ("  ~~  \\_#####\\", WHITE), ("  ~~     \\###|", WHITE), ("  ~~       \\#/ ___   https://aws.amazon.com/linux/amazon-linux-2023", WHITE),
    prompt(""),
])

# ---- Step 6: install httpd
terminal("Screenshot (49).png", [
    prompt("sudo dnf update -y"),
    ("Last metadata expiration check: 0:02:11 ago.", WHITE),
    ("Dependencies resolved.", WHITE), ("Nothing to do.", WHITE), ("Complete!", WHITE),
    prompt("sudo dnf install -y httpd"),
    ("Installing:", WHITE),
    (" httpd            x86_64   2.4.62-1.amzn2023     amazonlinux   47 k", WHITE),
    ("Installing dependencies:", WHITE),
    (" apr              x86_64   1.7.5-1.amzn2023.0.1  amazonlinux  129 k", WHITE),
    (" httpd-core       x86_64   2.4.62-1.amzn2023     amazonlinux  1.4 M", WHITE),
    ("Transaction Summary", WHITE), ("Install  9 Packages", WHITE),
    ("Installed:", WHITE), ("  httpd-2.4.62-1.amzn2023.x86_64   httpd-core-2.4.62-1.amzn2023.x86_64", WHITE),
    ("Complete!", GREEN),
    prompt(""),
])

# ---- Step 7: systemctl status
terminal("IMG_20261014_103015.png", [
    prompt("sudo systemctl start httpd"),
    prompt("sudo systemctl enable httpd"),
    ("Created symlink /etc/systemd/system/multi-user.target.wants/httpd.service", WHITE),
    ("  -> /usr/lib/systemd/system/httpd.service.", WHITE),
    prompt("sudo systemctl status httpd"),
    [("● ", GREEN), ("httpd.service - The Apache HTTP Server", WHITE)],
    ("     Loaded: loaded (/usr/lib/systemd/system/httpd.service; enabled; preset: disabled)", WHITE),
    [("     Active: ", WHITE), ("active (running)", GREEN), (" since Tue 2026-10-14 10:29:51 UTC; 21s ago", WHITE)],
    ("   Main PID: 26418 (httpd)", WHITE),
    ('     Status: "Started, listening on: port 80"', WHITE),
    ("      Tasks: 177 (limit: 1111)", WHITE),
    ("     Memory: 13.1M", WHITE),
    prompt(""),
])


# ---- Step 8: browser showing page by public IP
def browser(name, url, heading, sub):
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 52], fill="#dee1e6")
    d.rounded_rectangle([16, 10, W - 180, 42], 16, fill="white")
    d.text((36, 15), url, font=f(SANS, 18), fill="#202124")
    d.text((W // 2 - d.textlength(heading, font=f(SANS_B, 40)) // 2, 250), heading, font=f(SANS_B, 40), fill="#111")
    d.text((W // 2 - d.textlength(sub, font=f(SANS, 22)) // 2, 320), sub, font=f(SANS, 22), fill="#444")
    stamp(d)
    im.save(os.path.join(OUT, name))
browser("Screenshot (51).png", "Not secure | 13.233.45.112", "Hello from VU Cloud Lab 4!",
        "Served by Apache on EC2 instance i-0a1b2c3d4e5f67890")


# ---- Step 9: bucket created
def s9(d):
    d.rectangle([44, 170, W - 44, 220], fill="#f2fcf3", outline="#037f0c")
    d.text((64, 183), 'Successfully created bucket "vu-cc-lab4-demo-site"', font=f(SANS_B, 18), fill="#037f0c")
    table(d, 44, 250, ["Name", "AWS Region", "Access", "Creation date"],
          [["vu-cc-lab4-demo-site", "Asia Pacific (Mumbai) ap-south-1", "Objects can be public", "October 14, 2026, 10:41:07 (UTC+05:30)"]],
          [260, 330, 240, 360])
console("IMG_20261014_104112.png", "Amazon S3 > Buckets", "General purpose buckets (1)", s9)


# ---- Step 10: objects uploaded
def s10(d):
    d.rectangle([44, 170, W - 44, 220], fill="#f2fcf3", outline="#037f0c")
    d.text((64, 183), "Upload succeeded: 2 files, 1.3 KB", font=f(SANS_B, 18), fill="#037f0c")
    table(d, 44, 250, ["Name", "Type", "Size", "Status"],
          [["index.html", "html", "912.0 B", "Succeeded"], ["error.html", "html", "418.0 B", "Succeeded"]],
          [360, 200, 200, 300])
console("Screenshot (53).png", "Amazon S3 > Buckets > vu-cc-lab4-demo-site > Upload", "Upload: status", s10)


# ---- Step 11: static website hosting enabled (policy NOT visible -> partial)
def s11(d):
    d.text((44, 170), "Static website hosting", font=f(SANS_B, 20), fill="#16191f")
    kv(d, 44, 210, "Static website hosting", "Enabled", "#037f0c")
    kv(d, 44, 280, "Hosting type", "Bucket hosting")
    kv(d, 44, 350, "Index document", "index.html")
    kv(d, 420, 350, "Error document", "error.html")
    d.text((44, 430), "Bucket website endpoint", font=f(SANS, 15), fill="#5f6b7a")
    d.text((44, 452), "(endpoint URL cropped out of this screenshot)", font=f(SANS, 17), fill="#9aa0a6")
console("IMG_20261014_104630.png", "Amazon S3 > Buckets > vu-cc-lab4-demo-site > Properties", "Edit static website hosting", s11)

# ---- Unrelated image (should be left unmatched)
terminal("Screenshot (44).png", [
    [("admin1@DESKTOP-66GTQQD:~/dsa$ ", GREEN), ("python3 bubble_sort.py", WHITE)],
    ("Enter numbers: 5 3 8 1", WHITE),
    ("Sorted: [1, 3, 5, 8]", WHITE),
    [("admin1@DESKTOP-66GTQQD:~/dsa$ ", GREEN), ("", WHITE)],
])
print("written to", os.path.abspath(OUT))
