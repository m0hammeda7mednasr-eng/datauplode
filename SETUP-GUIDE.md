# 🚀 دليل التشغيل الاحترافي / Professional Setup Guide

## Syncly - Shopify Product Synchronizer

---

## 📋 المتطلبات / Prerequisites

- ✅ Node.js (v18 أو أحدث)
- ✅ npm أو yarn
- ✅ Shopify Store (اختياري للتست)
- ✅ Gemini API Key (اختياري للـ AI features)

---

## 🔧 خطوات التثبيت / Installation Steps

### 1️⃣ تثبيت الـ Dependencies

```bash
npm install
```

هيقوم تلقائياً بـ:

- تثبيت كل المكتبات المطلوبة
- تشغيل `prisma generate` لإنشاء Prisma Client

---

### 2️⃣ إعداد قاعدة البيانات / Database Setup

```bash
npm run db:push
```

هيقوم بـ:

- إنشاء قاعدة بيانات SQLite
- تطبيق الـ schema من `prisma/schema.prisma`

---

### 3️⃣ تعديل ملف `.env`

افتح ملف `.env` وحط البيانات بتاعتك:

```env
# Gemini API Key (اختياري - للـ AI features)
GEMINI_API_KEY="your-actual-gemini-api-key"

# App URL
APP_URL="http://localhost:3000"

# Shopify Configuration (حط بيانات متجرك)
SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
SHOPIFY_ACCESS_TOKEN="shpat_your_actual_token"

# Encryption Key (32 حرف)
ENCRYPTION_KEY="your-random-32-character-key!"
```

**ملحوظة:** لو عاوز تعمل تست للسكرابينج بس، مش محتاج Shopify credentials دلوقتي.

---

## 🧪 اختبار السكرابينج / Test Scraping

### تشغيل اختبار السكرابينج:

```bash
npm run test:scraper
```

هيقوم بـ:

- ✅ اختبار السكرابينج على مواقع مختلفة
- ✅ عرض النتائج بشكل احترافي
- ✅ حفظ النتائج في `scraper-test-results.json`
- ✅ قياس الأداء والسرعة

---

## 🚀 تشغيل المشروع / Run the Project

### Development Mode:

```bash
npm run dev
```

المشروع هيشتغل على:

- 🌐 Frontend: http://localhost:5173
- 🔧 Backend API: http://localhost:3000

---

## 📊 أدوات إضافية / Additional Tools

### فتح Prisma Studio (لإدارة قاعدة البيانات):

```bash
npm run db:studio
```

### Build للـ Production:

```bash
npm run build
```

### Type Checking:

```bash
npm run lint
```

---

## 🎯 الميزات / Features

### ✨ السكرابينج الذكي / Smart Scraping

- دعم مواقع متعددة (Next.co.uk, Amazon, وغيرها)
- استخراج تلقائي للبيانات (عنوان، سعر، صور، variants)
- معالجة أخطاء احترافية
- User-Agent rotation لتجنب الحظر

### 🔄 المزامنة مع Shopify / Shopify Sync

- ربط المنتجات تلقائياً
- تحديث الأسعار والمخزون
- إدارة الـ variants
- قواعد التسعير المخصصة

### 🤖 AI Integration

- استخدام Gemini AI لتحسين البيانات
- مطابقة المنتجات الذكية
- اقتراحات تلقائية

### 📦 إدارة المنتجات / Product Management

- استيراد من URLs
- مراجعة يدوية
- تتبع حالة المزامنة
- سجل التغييرات

---

## 🐛 استكشاف الأخطاء / Troubleshooting

### مشكلة: `prisma generate` فشل

**الحل:**

```bash
npx prisma generate
```

### مشكلة: Port 3000 مستخدم

**الحل:** غير الـ port في `server.ts`

### مشكلة: السكرابينج بيرجع 403

**الحل:** السكريبت بيستخدم User-Agent rotation تلقائياً، لكن بعض المواقع محمية أكتر.

---

## 📝 ملاحظات مهمة / Important Notes

1. **السكرابينج القانوني:** تأكد إنك بتلتزم بـ Terms of Service للمواقع اللي بتعمل لها scraping
2. **Rate Limiting:** المشروع بيستخدم queue system عشان ميحملش على المواقع
3. **البيانات الحساسة:** متحطش API keys في Git - استخدم `.env` دايماً

---

## 🎓 الخطوات التالية / Next Steps

1. ✅ جرب السكرابينج: `npm run test:scraper`
2. ✅ شغل المشروع: `npm run dev`
3. ✅ افتح البراوزر: http://localhost:5173
4. ✅ استكشف الـ Dashboard والميزات

---

## 📞 الدعم / Support

لو عندك أي مشكلة أو استفسار، اتواصل معايا! 🚀

---

**صنع بـ ❤️ في مصر**
