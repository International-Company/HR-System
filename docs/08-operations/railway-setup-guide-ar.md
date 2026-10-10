# دليل التشغيل على Railway — خطوة بخطوة (لمالك النظام)

هذا الدليل يشرح ما تقوم به **أنت** في حساباتك (GitHub وBackblaze وRailway). لا أستطيع الدخول إلى حساباتك، ولن أحاول ذلك.
المدة المتوقعة: 45–60 دقيقة في المرة الأولى.

> **قاعدة مهمة:** كل القيم السرية (كلمات المرور والمفاتيح) تُكتب فقط في متغيرات Railway، ولا تُرسل في المحادثة ولا تُحفظ في GitHub.

---

## الجزء 0 — جهّز 5 قيم سرية عشوائية

استخدم مولّد كلمات مرور (مثل Bitwarden أو 1Password أو مدير كلمات المرور في المتصفح بأطول طول ممكن). اجعل **كل قيمة 48 حرفاً على الأقل** من حروف وأرقام:

| الاسم | الاستخدام | احفظ نسخة خارج النظام؟ |
|---|---|---|
| `SESSION_SECRET` | حماية الجلسات | لا (يمكن تغييره، وسيُخرج الجميع فقط) |
| `DB_APP_PASSWORD` | كلمة مرور الدور المحدود الصلاحيات في قاعدة البيانات | لا |
| `DATA_ENCRYPTION_KEY` | تشفير البيانات الحساسة (مثل الحسابات البنكية) | **نعم — إلزامي** |
| `BACKUP_ENCRYPTION_KEY` | تشفير النسخ الاحتياطية | **نعم — إلزامي** |
| `BOOTSTRAP_ADMIN_PASSWORD` | كلمة مرور مؤقتة لأول مدير نظام (12 حرفاً على الأقل) | لا (ستغيّرها عند أول دخول) |

> ⚠️ **احفظ `DATA_ENCRYPTION_KEY` و`BACKUP_ENCRYPTION_KEY` في مكانين آمنين خارج النظام** (مثل مدير كلمات المرور + نسخة ورقية في خزنة). إذا فُقدا فلن يمكن قراءة البيانات المشفرة ولا استعادة النسخ الاحتياطية. وبعد بدء العمل **لا تغيّرهما أبداً**.

---

## الجزء 1 — GitHub

1. أنشئ مستودعاً **خاصاً (Private)** جديداً فارغاً، مثلاً باسم `hrms`. لا تضف إليه README ولا ملفات.
2. أرسل لي **رابط المستودع فقط** (مثل `https://github.com/<اسمك>/hrms.git`). سأطلب موافقتك قبل رفع الكود إليه من جهازك. قد يفتح Git نافذة في المتصفح لتسجيل دخولك إلى GitHub: هذه نافذة GitHub الرسمية، وأنت من يسجّل الدخول.
3. (موصى به) بعد الرفع: Settings ← Branches ← أضف حماية لفرع `main` (طلب سحب + نجاح فحوصات CI).

---

## الجزء 2 — Backblaze B2 (النسخ الاحتياطية خارج Railway، داخل الاتحاد الأوروبي)

1. أنشئ حساباً على backblaze.com، واختر عند التسجيل **منطقة EU Central**. منطقة الحساب تُحدد عند التسجيل ولا تتغير.
2. Buckets ← **Create a Bucket**:
   - الاسم: فريد، مثل `hrms-backups-<أرقام عشوائية>`
   - Files in Bucket: **Private**
   - Default Encryption: **Enable**
   - **Object Lock: Enable** (لا يمكن تفعيله لاحقاً)
3. افتح إعدادات Object Lock للـ bucket: Default Retention **Governance**، المدة **35 يوماً**. بهذا لا يمكن حذف أي نسخة احتياطية قبل 35 يوماً، حتى لو اختُرق النظام.
4. Lifecycle Settings ← Custom: احذف الملفات بعد **400 يوم** من رفعها، أي احتفاظ بالنسخ لأكثر من سنة. يمكنك تعديل المدة لاحقاً.
5. Application Keys ← **Add a New Application Key**:
   - Allow access to: **هذا الـ bucket فقط**
   - Type of Access: **Read and Write**
   - احفظ `keyID` و`applicationKey` فوراً، فهي تُعرض مرة واحدة.
6. سجّل **Endpoint** الظاهر في صفحة الـ bucket، مثل `s3.eu-central-003.backblazeb2.com`.

---

## الجزء 3 — Railway

### 3.1 المشروع والمنطقة
1. New Project ← **Deploy from GitHub repo** ← اختر المستودع `hrms`. ستظهر خدمة جديدة: أعد تسميتها إلى `web`.
2. في أعلى المشروع: **Environments** ← أنشئ بيئة باسم `staging` واعمل فيها الآن. بيئة `production` نستخدمها لاحقاً عند الإطلاق الرسمي.
3. لكل خدمة: Settings ← **Region**: اختر **EU West (Amsterdam)**.

### 3.2 قاعدة البيانات
1. داخل بيئة `staging`: **New ← Database ← PostgreSQL**. تأكد أن المنطقة EU West.
2. خدمة Postgres ← تبويب **Backups** ← فعّل الجداول الثلاثة **Daily وWeekly وMonthly**. هذه طبقة الحماية الأولى؛ النسخ المشفرة في Backblaze هي الطبقة الثانية.

### 3.3 المتغيرات المشتركة (Shared Variables)
Project Settings ← **Shared Variables** (لبيئة `staging`). أضف:

| المتغير | القيمة |
|---|---|
| `APP_ENV` | `staging` |
| `DB_APP_PASSWORD` | القيمة العشوائية من الجزء 0 |
| `SESSION_SECRET` | القيمة العشوائية من الجزء 0 |
| `DATA_ENCRYPTION_KEY` | القيمة العشوائية من الجزء 0 |
| `TRUST_PROXY` | `1` |
| `BACKUP_ENCRYPTION_KEY` | القيمة العشوائية من الجزء 0 |
| `BACKUP_S3_ENDPOINT` | `https://` + الـ Endpoint من الجزء 2، مثل `https://s3.eu-central-003.backblazeb2.com` |
| `BACKUP_S3_REGION` | الجزء الأوسط من الـ Endpoint، مثل `eu-central-003` |
| `BACKUP_S3_BUCKET` | اسم الـ bucket |
| `BACKUP_S3_ACCESS_KEY_ID` | `keyID` |
| `BACKUP_S3_SECRET_ACCESS_KEY` | `applicationKey` |

### 3.4 خدمة `web`
1. Settings ← **Config-as-code / Railway Config File**: ضع المسار `railway/web.json`.
2. Variables ← اربط **كل** المتغيرات المشتركة (Add shared variables)، ثم أضف لهذه الخدمة:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (اكتبها كما هي؛ Railway يستبدلها برابط قاعدة البيانات الداخلي)
   - `BOOTSTRAP_ADMIN_USERNAME` = اسم المستخدم لأول مدير (مثل `admin`)
   - `BOOTSTRAP_ADMIN_PASSWORD` = كلمة المرور المؤقتة
   - `BOOTSTRAP_GROUP_NAME_AR` = اسم مجموعة الشركات بالعربية
   - `BOOTSTRAP_GROUP_NAME_EN` = اسم المجموعة بالإنجليزية
3. Settings ← Networking ← **Generate Domain**. لاحقاً يمكن ربط نطاقك الخاص، وهو ضروري قبل تفعيل البصمة في المرحلة الرابعة.

### 3.5 خدمة `worker` (المهام الخلفية: النسخ الاحتياطي والتحقق)
1. **New ← GitHub Repo** ← نفس المستودع، وأعد تسميتها إلى `worker`.
2. Settings ← Config file: `railway/worker.json`. المنطقة: EU West. **لا تولّد** لها نطاقاً (Domain).
3. Variables ← اربط **كل** المتغيرات المشتركة، وأضف `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.

### 3.6 أول تشغيل
1. Deploy للخدمتين. خدمة `web` تنفّذ ترحيل قاعدة البيانات تلقائياً قبل التشغيل، وتنشئ أول مدير.
2. افتح: `https://<النطاق>/api/v1/health/ready`. يجب أن يظهر `"status":"ok"`.
3. افتح `https://<النطاق>/` ← سجّل الدخول بحساب المدير ← سيطلب النظام **تغيير كلمة المرور** ثم **إعداد التحقق بخطوتين**. احفظ رموز الاسترداد.
4. **احذف** المتغير `BOOTSTRAP_ADMIN_PASSWORD` من خدمة `web` بعد نجاح الدخول.
5. من القائمة: **النسخ الاحتياطي** ← "نسخ احتياطي الآن" ← انتظر دقيقة ← "تشغيل اختبار الاستعادة" ← يجب أن تكون النتيجة **نجح**. هذا هو اختبار الاستعادة المطلوب لقبول المرحلة الأولى.
6. **الإعدادات** ← اضبط المنطقة الزمنية (مثل `Europe/Berlin` حسب بلدك) والعملة الافتراضية.

### 3.7 حاوية المستندات (مطلوبة من المرحلة الثانية)
مستندات الموظفين (الشهادات والهويات والصور) تُحفظ **مشفرة** في حاوية تخزين على Railway.
1. داخل البيئة: **New ← Bucket**، في منطقة **EU West**. Railway يسميها غالباً `Bucket`.
2. في خدمة `web` ← Variables، أضف هذه القيم **كمراجع** (Add Variable Reference) إلى الحاوية:

| المتغير | القيمة |
|---|---|
| `FILES_S3_BUCKET` | `${{Bucket.BUCKET}}` |
| `FILES_S3_ACCESS_KEY_ID` | `${{Bucket.ACCESS_KEY_ID}}` |
| `FILES_S3_SECRET_ACCESS_KEY` | `${{Bucket.SECRET_ACCESS_KEY}}` |
| `FILES_S3_ENDPOINT` | `${{Bucket.ENDPOINT}}` |
| `FILES_S3_REGION` | `${{Bucket.REGION}}` |

إذا كان اسم الحاوية مختلفاً عن `Bucket`، استبدل الاسم داخل `${{...}}` باسمها.
3. أعد نشر `web`. بدون هذه المتغيرات يعمل النظام، لكن رفع المستندات يعطي رسالة "غير مهيأ".

### 3.8 ما بعد التشغيل
- أرسل لي رابط الموقع ونتيجة الخطوة 5 فقط، **بدون أي قيمة سرية**.
- في Railway ← Workspace ← **Usage**: ضع حداً أعلى للاستهلاك وتنبيهاً، للتحكم بالتكلفة.

---

## مشاكل شائعة

| العرض | السبب المحتمل | الحل |
|---|---|---|
| فشل النشر في خطوة Pre-deploy | متغير ناقص أو قصير | راجع سجلات النشر (Deploy Logs): رسالة `Invalid configuration` تحدد المتغير |
| الصفحة تعمل لكن الدخول يفشل دائماً | `TRUST_PROXY` غير مضبوط، أو الرابط http | تأكد من `TRUST_PROXY=1` واستخدم رابط https |
| النسخ الاحتياطي "غير مهيأ" | متغيرات `BACKUP_*` ناقصة في خدمة worker أو web | اربط المتغيرات المشتركة بالخدمتين |
| فشل النسخ الاحتياطي برسالة صلاحيات | مفتاح Backblaze لا يغطي الـ bucket | أنشئ المفتاح مرة أخرى للـ bucket نفسه بصلاحية Read and Write |
