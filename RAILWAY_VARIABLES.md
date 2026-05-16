# 🚀 Railway Environment Variables - النسخة النهائية

## ✅ المتغيرات المطلوبة للنسخة Live

انسخ كل المتغيرات دي وضيفها في Railway Dashboard → Variables:

### 🔐 Database & Authentication

```
DATABASE_URL=postgresql://postgres.gqjwyldmajaeraydlcip:01066184859Mm@aws-0-eu-west-1.pooler.supabase.com:5432/postgres

SUPABASE_URL=https://gqjwyldmajaeraydlcip.supabase.co

SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxand5bGRtYWphZXJheWRsY2lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NzYzMTksImV4cCI6MjA5NDE1MjMxOX0.XfJGoGKWzgfeZXfmhXKQRP6rt7QjQiWH-4ZivZeyiHs

SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxand5bGRtYWphZXJheWRsY2lwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODU3NjMxOSwiZXhwIjoyMDk0MTUyMzE5fQ.1e99yqK9NBFg6PAxkJZT16-ZlnXd25_2RpcU7Tb2pA8

ENCRYPTION_KEY=7Gs6GqvblRlZ5Bts8Xmb5M0DHaF2grJz+Wxf2C2I+s3NmO/rYr//zkilauGiRvJI+5mxhm93dY4TwFF4MraWeA==
```

### 🌐 URLs & CORS

```
APP_URL=https://datauplode-production.up.railway.app

FRONTEND_URL=https://datauplode.vercel.app

CORS_ORIGINS=https://datauplode-production.up.railway.app,https://datauplode.vercel.app
```

### 🛒 Shopify

```
SHOPIFY_API_VERSION=2026-04
```

### 🤖 Scraper Configuration (الأهم!)

```
SCRAPER_BYPASS_MODE=auto

SCRAPER_BYPASS_PROVIDERS=scraperapi

SCRAPER_BYPASS_DAILY_LIMIT=400

SCRAPER_BYPASS_COOLDOWN_MINUTES=0

SCRAPERAPI_KEY=457497d563b553d7c70eccad295ccbfc

SCRAPERAPI_RENDER=true

SCRAPERAPI_COUNTRY_CODE=ae

SCRAPERAPI_DEVICE_TYPE=mobile

SCRAPERAPI_PREMIUM=true
```

### ⚙️ Environment

```
NODE_ENV=production
```

---

## 📋 الخطوات:

1. **افتح Railway Dashboard**: https://railway.app
2. **اختار الـ project**: datauplode
3. **روح على Variables**
4. **امسح أي variables فاضية أو غلط**
5. **ضيف كل الـ variables اللي فوق واحدة واحدة**
6. **اضغط Deploy**

---

## ✅ بعد الـ Deploy:

### المواقع اللي هتشتغل:

- ✅ **Next** (ScraperAPI)
- ✅ **Max Fashion** (ScraperAPI)
- ✅ **Centrepoint** (ScraperAPI)
- ✅ **Marks & Spencer** (ScraperAPI)
- ✅ **Shein** (curl + ScraperAPI backup)
- ✅ **H&M** (curl مجاني)
- ✅ **Zara** (curl مجاني)
- ✅ **Gap** (curl مجاني)
- ✅ **Lefties** (curl مجاني)
- ✅ **Mothercare** (curl مجاني)

---

## 🎯 الاستخدام:

- **400 request يومياً** من ScraperAPI للمواقع المحجوبة
- **باقي المواقع مجاني 100%**
- لو خلصت الـ 400، الموقع هيطلب **Snapshot** (المستخدم يلصق النص)

---

## 🔍 التأكد من النجاح:

بعد الـ deploy، جرب:

```
https://datauplode-production.up.railway.app/api/health
```

لازم يرجع:

```json
{
  "ok": true,
  "database": "ok",
  "environment": "production"
}
```

---

## ⚠️ ملاحظات مهمة:

1. **لا تضيف variables فاضية** - Railway مش بيقبلها
2. **تأكد من عدم وجود مسافات** قبل أو بعد أسماء الـ variables
3. **SCRAPERAPI_KEY** هو الأهم - بدونه المواقع المحجوبة مش هتشتغل
4. **SUPABASE_ANON_KEY** ضروري - بدونه الـ database مش هيشتغل

---

## 📞 لو حصلت مشكلة:

1. شوف الـ **Deploy Logs** في Railway
2. شوف الـ **HTTP Logs** لو في errors
3. تأكد إن كل الـ variables موجودة بالظبط زي ما هي فوق
