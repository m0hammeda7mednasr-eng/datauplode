# 🚀 Quick Start - البدء السريع

## المشروع شغال دلوقتي! / Project is Running Now!

---

## 🌐 الوصول للتطبيق / Access the Application

### التطبيق الكامل (Frontend + Backend):

```
http://localhost:3000
```

افتح المتصفح وروح على الرابط ده ⬆️

**ملحوظة:** السيرفر بيخدم الـ Frontend والـ Backend على نفس الـ Port (3000)!

---

## ✅ ما تم إنجازه / What's Done

- ✅ تثبيت جميع المكتبات / All dependencies installed
- ✅ إعداد قاعدة البيانات / Database setup complete
- ✅ إنشاء ملف `.env` / Environment file created
- ✅ تشغيل السيرفر / Server is running
- ✅ اختبار السكرابينج / Scraping test completed

---

## 📱 الصفحات المتاحة / Available Pages

بعد ما تفتح http://localhost:5173 هتلاقي:

1. **Dashboard** - لوحة التحكم الرئيسية
2. **Import Product** - استيراد منتج من URL
3. **Linked Products** - المنتجات المربوطة
4. **Manual Review** - المراجعة اليدوية
5. **Pricing Rules** - قواعد التسعير
6. **Sync Jobs** - وظائف المزامنة
7. **Settings** - الإعدادات

---

## 🧪 اختبار السكرابينج / Test Scraping

### تست تجريبي (بدون انترنت):

```bash
npm run test:scraper:demo
```

✅ **تم تشغيله بنجاح!** - يعرض منتجات تجريبية

### تست حقيقي (يحتاج انترنت):

```bash
npm run test:scraper
```

⚠️ ملحوظة: بعض المواقع محمية ضد السكرابينج

---

## 🔧 أوامر مفيدة / Useful Commands

### إيقاف السيرفر / Stop Server:

اضغط `Ctrl + C` في الـ terminal

### إعادة تشغيل السيرفر / Restart Server:

```bash
npm run dev
```

### فتح Prisma Studio (إدارة قاعدة البيانات):

```bash
npm run db:studio
```

### Type Checking:

```bash
npm run lint
```

### Build للـ Production:

```bash
npm run build
```

---

## 📝 استخدام السكرابينج / Using the Scraper

### من الكود:

```typescript
import { ScraperService } from "./src/server/services/scraper";

const scraper = new ScraperService();

// سكرابينج منتج
const product = await scraper.scrape("https://example.com/product");

// فحص التوفر
const availability = await scraper.checkAvailability(
  "https://example.com/product",
);
```

### من الواجهة:

1. افتح http://localhost:5173
2. اذهب إلى "Import Product"
3. الصق URL المنتج
4. اضغط "Import"

---

## 🔐 إعداد Shopify (اختياري)

لو عاوز تربط مع متجر Shopify حقيقي:

1. افتح `.env`
2. حط بيانات متجرك:

```env
SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
SHOPIFY_ACCESS_TOKEN="shpat_your_actual_token"
```

### كيف تحصل على Shopify Access Token:

1. اذهب إلى Shopify Admin
2. Settings → Apps and sales channels
3. Develop apps → Create an app
4. Configure Admin API scopes (اختار الصلاحيات المطلوبة)
5. Install app
6. انسخ الـ Admin API access token

---

## 🎯 الخطوات التالية / Next Steps

### 1. استكشف الواجهة:

- افتح http://localhost:5173
- جرب الصفحات المختلفة
- شوف الـ Dashboard

### 2. جرب استيراد منتج:

- اذهب إلى "Import Product"
- جرب URL منتج حقيقي
- شوف النتائج

### 3. اضبط قواعد التسعير:

- اذهب إلى "Pricing Rules"
- أضف قواعد مخصصة
- حدد نسب الربح

### 4. راجع الكود:

- شوف `src/server/services/scraper.ts` - منطق السكرابينج
- شوف `src/pages/` - صفحات الواجهة
- شوف `src/server/api.ts` - API endpoints

---

## 🐛 حل المشاكل / Troubleshooting

### المشروع مش شغال؟

```bash
# أعد تثبيت المكتبات
npm install

# أعد إنشاء قاعدة البيانات
npm run db:push

# شغل المشروع
npm run dev
```

### Port مستخدم؟

غير الـ port في `server.ts`:

```typescript
const PORT = 3001; // بدل 3000
```

### مشكلة في السكرابينج؟

- تأكد من الانترنت
- بعض المواقع محمية ضد bots
- جرب URLs مختلفة

---

## 📚 ملفات مهمة / Important Files

- `SETUP-GUIDE.md` - دليل التثبيت الكامل
- `README.md` - معلومات عامة
- `.env` - إعدادات البيئة
- `server.ts` - السيرفر الرئيسي
- `src/server/services/scraper.ts` - منطق السكرابينج
- `prisma/schema.prisma` - هيكل قاعدة البيانات

---

## 💡 نصائح / Tips

1. **احفظ عملك باستمرار** - الكود بيتحفظ تلقائياً
2. **استخدم Prisma Studio** - لإدارة البيانات بسهولة
3. **راجع الـ Console** - لمتابعة الأخطاء
4. **اقرأ الكود** - لفهم كيفية العمل
5. **جرب وتعلم** - المشروع جاهز للتجربة!

---

## 🎉 مبروك!

المشروع شغال بنجاح وجاهز للاستخدام! 🚀

**استمتع بالتطوير! / Happy Coding!** 💻✨

---

**صنع بـ ❤️ في مصر**
