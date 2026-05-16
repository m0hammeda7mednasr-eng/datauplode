# ✅ Railway Setup Checklist - قائمة التحقق

## 🎯 الهدف: تشغيل كل المواقع على النسخة Live

---

## 📝 الخطوات بالترتيب:

### ✅ الخطوة 1: تنظيف Variables القديمة

- [ ] افتح Railway Dashboard
- [ ] روح على Variables
- [ ] **امسح** أي variable اسمها فاضي
- [ ] **امسح** أي variable قيمتها فاضية
- [ ] **امسح** المتغير الغلط: `FRONTEND_UR` (لو موجود)

---

### ✅ الخطوة 2: إضافة Variables الأساسية

#### Database (ضروري جداً!)

- [ ] `DATABASE_URL` = `postgresql://postgres.gqjwyldmajaeraydlcip:01066184859Mm@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`
- [ ] `SUPABASE_URL` = `https://gqjwyldmajaeraydlcip.supabase.co`
- [ ] `SUPABASE_ANON_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxand5bGRtYWphZXJheWRsY2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NzYzMTksImV4cCI6MjA5NDE1MjMxOX0.XfJGoGKWzgfeZXfmhXKQRP6rt7QjQiWH-4ZivZeyiHs`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxand5bGRtYWphZXJheWRsY2lwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODU3NjMxOSwiZXhwIjoyMDk0MTUyMzE5fQ.1e99yqK9NBFg6PAxkJZT16-ZlnXd25_2RpcU7Tb2pA8`

#### Security

- [ ] `ENCRYPTION_KEY` = `7Gs6GqvblRlZ5Bts8Xmb5M0DHaF2grJz+Wxf2C2I+s3NmO/rYr//zkilauGiRvJI+5mxhm93dY4TwFF4MraWeA==`

#### URLs

- [ ] `APP_URL` = `https://datauplode-production.up.railway.app`
- [ ] `FRONTEND_URL` = `https://datauplode.vercel.app`
- [ ] `CORS_ORIGINS` = `https://datauplode-production.up.railway.app,https://datauplode.vercel.app`

#### Shopify

- [ ] `SHOPIFY_API_VERSION` = `2026-04`

#### Environment

- [ ] `NODE_ENV` = `production`

---

### ✅ الخطوة 3: إضافة Scraper Variables (الأهم!)

- [ ] `SCRAPER_BYPASS_MODE` = `auto`
- [ ] `SCRAPER_BYPASS_PROVIDERS` = `scraperapi`
- [ ] `SCRAPER_BYPASS_DAILY_LIMIT` = `400`
- [ ] `SCRAPER_BYPASS_COOLDOWN_MINUTES` = `0`
- [ ] `SCRAPERAPI_KEY` = `457497d563b553d7c70eccad295ccbfc`
- [ ] `SCRAPERAPI_RENDER` = `true`
- [ ] `SCRAPERAPI_COUNTRY_CODE` = `ae`
- [ ] `SCRAPERAPI_DEVICE_TYPE` = `mobile`
- [ ] `SCRAPERAPI_PREMIUM` = `true`

---

### ✅ الخطوة 4: Deploy

- [ ] اضغط على **Deploy** (أو انتظر auto-deploy)
- [ ] انتظر 2-3 دقايق للـ build
- [ ] شوف الـ **Deploy Logs** للتأكد من عدم وجود errors

---

### ✅ الخطوة 5: التحقق من النجاح

#### Test 1: Health Check

- [ ] افتح: `https://datauplode-production.up.railway.app/api/health`
- [ ] تأكد من: `"ok": true` و `"database": "ok"`

#### Test 2: Frontend

- [ ] افتح: `https://datauplode.vercel.app`
- [ ] جرب تحلل منتج من **Centrepoint**
- [ ] URL للاختبار: `https://www.centrepointstores.com/ae/en/buy-pack-of-3-juniors-cotton-round-neck-long-sleeves-sleepsuit-with-zip-closure/p/FSV028S26MULTICOLORMULTISHADE`

#### Test 3: Next (المحجوب)

- [ ] جرب منتج من **Next**
- [ ] URL للاختبار: `https://www.next.ae/en/style/su876474/y19782`
- [ ] لازم يشتغل **بدون** طلب Snapshot

---

## 🎉 النتيجة المتوقعة:

### ✅ المواقع اللي هتشتغل:

1. ✅ Next
2. ✅ Max Fashion
3. ✅ Centrepoint
4. ✅ Marks & Spencer
5. ✅ Shein
6. ✅ H&M
7. ✅ Zara
8. ✅ Gap
9. ✅ Lefties
10. ✅ Mothercare

---

## ❌ لو حصلت مشاكل:

### مشكلة: "Can't reach database"

**الحل:**

- تأكد من `DATABASE_URL` صحيح
- تأكد من `SUPABASE_ANON_KEY` موجود

### مشكلة: "CORS blocked"

**الحل:**

- تأكد من `CORS_ORIGINS` فيه الـ Vercel URL
- تأكد من `FRONTEND_URL` صحيح

### مشكلة: "Supplier blocked server analysis"

**الحل:**

- تأكد من `SCRAPERAPI_KEY` موجود
- تأكد من `SCRAPER_BYPASS_MODE` = `auto`
- تأكد من `SCRAPER_BYPASS_DAILY_LIMIT` > 0

---

## 📊 الاستخدام اليومي:

- **400 request** من ScraperAPI للمواقع المحجوبة
- **باقي المواقع مجاني 100%**
- **5000 request شهرياً** من ScraperAPI (مجاني)

---

## 🔄 بعد التحديث:

- [ ] ارفع الملفات على GitHub (لو في تعديلات)
- [ ] Railway هيعمل auto-deploy
- [ ] جرب كل المواقع مرة تانية

---

## ✅ تم! 🎉

لو كل الخطوات اتعملت، كل المواقع هتشتغل 100% على النسخة Live!
