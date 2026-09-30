// lib/services.js — Chat, Mock Interview, Cover Letter generation.
const fs = require('fs');
const path = require('path');
const { chat, chatJson } = require('./ai');
const { readSession, writeSession, patchSession } = require('./pipeline');

function cvContext(session) {
  const cv = session.cv || {};
  const jd = session.jd;
  const r = session.result || {};
  const alts = (r.alternativePaths || []).map(a => a.role);
  return `=== CV ỨNG VIÊN: ${cv.candidateName || ''} (${session.meta?.targetRole || ''} | ${session.meta?.experienceLevel || ''}) ===
${(cv.cleanedCv || '').slice(0, 10000)}

${jd ? `=== TIN TUYỂN DỤNG MỤC TIÊU ===
Vị trí: ${jd.title} tại ${jd.company || '?'} (${jd.location || '?'})
Yêu cầu bắt buộc: ${JSON.stringify(jd.mustHave)}
Yêu cầu nên có: ${JSON.stringify(jd.niceToHave || [])}
Điểm khớp ATS: ${r.match?.matchScore ?? '?'}/100 — ${r.match?.verdict || ''}
Kỹ năng còn thiếu: ${JSON.stringify((r.match?.missing || []).map(m => m.requirement))}` : '=== KHÔNG CÓ JD ==='}

=== PHÂN TÍCH ĐÃ CÓ ===
Điểm tổng: ${r.overallScore ?? '?'}/100
Tóm tắt: ${r.summary || ''}
Điểm yếu chính: ${JSON.stringify((r.weaknesses || []).map(w => w.point))}
Lộ trình: ${JSON.stringify((r.roadmap || []).map(s => `${s.step}. ${s.skill} (${s.duration})`))}
${alts.length ? `HƯỚNG ĐI KHÁC AI ĐÃ ĐỀ XUẤT (CV này có lợi thế hơn ở đây): ${alts.join(' ; ')}` : ''}`;
}

// ---------- Chat ----------
// images: [{ base64, mime }] — optional screenshots/questions sent by the user
async function chatTurn(session, userMessage, history, images) {
  const system = `Bạn là "HireMind Coach" — cố vấn nghề nghiệp AI của nền tảng HireMind, chuyên giúp ứng viên Việt Nam cải thiện CV và chuẩn bị ứng tuyển. Bạn có đầy đủ ngữ cảnh về CV và tin tuyển dụng mục tiêu của người dùng dưới đây.

Nguyên tắc:
- Trả lời TIẾNG VIỆT, thân thiện, cụ thể, đi thẳng vào vấn đề.
- Luôn trả lời bằng Markdown có cấu trúc: dùng **in đậm** cho ý chính, bullet (-) cho liệt kê, ### cho các mục con khi cần — để giao diện render đẹp.
- Khi tư vấn sửa CV, TRÍCH DẪN vị trí/dòng cụ thể trong CV của họ, đưa ví dụ "trước → sau" khi có thể.
- Khi tư vấn học thêm gì, ưu tiên theo lộ trình đã phân tích; gợi ý nguồn học miễn phí/nổi tiếng (freeCodeCamp, Coursera, YouTube, docs chính thức...).
- Không bịa thông tin không có trong CV; nếu cần thêm thông tin thì hỏi lại ngắn gọn.
- Nếu người dùng gửi ảnh (CV mới, screenshot lỗi, bằng chứng...), hãy đọc nội dung ảnh và tư vấn dựa trên đó.
- Trả lời ngắn gọn có cấu trúc (bullet, đoạn ngắn), tối đa ~350 từ trừ khi người dùng yêu cầu chi tiết hơn.

${cvContext(session)}`;

  // Build the user message content — with images if provided
  let userContent;
  const imgs = (images || []).filter(im => im && im.base64).slice(0, 3);
  if (imgs.length) {
    userContent = [
      ...imgs.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${im.base64}` } })),
      { type: 'text', text: userMessage || 'Đọc ảnh này và tư vấn giúp mình.' },
    ];
  } else {
    userContent = userMessage;
  }

  const messages = [{ role: 'system', content: system }, ...history.slice(-12), { role: 'user', content: userContent }];
  return chat(messages, { maxTokens: 4000, temperature: 0.5 });
}

// ---------- Mock Interview ----------
// Interviewer mood states — hiển thị cho ứng viên như "đọc tín hiệu" người thật.
// Based on real stress-interview & body-language research (dismissive behavior, silences,
// rapid-fire pivots, warm vs cold tone). AI emits ===MOOD:xxx=== next to its question.
const MOODS = {
  warm:       { label: 'Vui vẻ, cởi mở',   emoji: '😊', color: 'green',  tip: 'Câu trả lời của bạn đang ghi điểm. Giữ nhịp này, nêu thêm dẫn chứng cụ thể.' },
  neutral:    { label: 'Trung lập',        emoji: '😐', color: 'sky',    tip: 'PV đang lắng nghe và đánh giá. Trả lời có cấu trúc, đi thẳng vào ý chính.' },
  skeptical:  { label: 'Nghi ngờ',         emoji: '🤨', color: 'amber',  tip: 'PV chưa thấy thuyết phục. Đưa số liệu/dẫn chứng cụ thể thay vì mô tả chung.' },
  annoyed:    { label: 'Khó chịu',         emoji: '😒', color: 'red',    tip: 'Câu trả lời lan man hoặc lệch trọng tâm. Dừng lan man — tóm gọn ý chính ngay.' },
  silence:    { label: 'Im lặng áp lực',   emoji: '🕰️', color: 'amber',  tip: 'Im lặng là một phép thử. Giữ bình tĩnh, đừng tự rút lại câu trả lời; hỏi lại "Anh/chị cần em làm rõ phần nào không ạ?"' },
  stress:     { label: 'Đá xoáy',          emoji: '⚡', color: 'red',    tip: 'Đây là stress interview — họ thử độ bình tĩnh. Đừng phản ứng quá, giữ giọng điềm tĩnh, rõ ràng.' },
  impressed:  { label: 'Ấn tượng',         emoji: '🤩', color: 'green',  tip: 'PV rất thích câu trả lời. Có thể xin nhấn thêm điểm mạnh của bạn ở câu sau.' },
  ending:     { label: 'Muốn kết thúc',    emoji: '⏳', color: 'red',    tip: 'PV đang muốn khép lại sớm. Nếu còn điểm mạnh nào chưa nói, đây là lúc chốt nhanh gọn.' },
};

function interviewSystem(session, opts = {}) {
  const jd = session.jd;
  const hard = (session.result?.hardQuestions || []);
  const prep = opts.waitForReady;

  return `Bạn là "Phỏng vấn viên" — một hiring manager thực thụ của vị trí "${session.jd?.title || session.meta?.targetRole || 'ứng viên nhắm tới'}"${jd?.company ? ` tại ${jd.company}` : ''}. Bạn đang phỏng vấn ứng viên dựa trên CV thật của họ.

${cvContext(session)}

${hard.length ? `CÁC CÂU HỎI KHÓ ĐÃ ĐƯỢC DỰ BÁO (dùng làm cảm hứng, đừng hỏi lại y nguyên): ${JSON.stringify(hard)}` : ''}

QUY TẮC PHỎNG VẤN:
- Hỏi TIẾNG VIỆT, mỗi lượt CHỈ MỘT câu hỏi, ngắn gọn như phỏng vấn thật.
- Bám sát CV của ứng viên: hỏi sâu vào kinh nghiệm, dự án, kỹ năng họ khai. Nếu câu trả lời mơ hồ hoặc không có dẫn chứng → hỏi làm rõ như interviewer thật.
- Xen kẽ: câu hỏi kỹ thuật/kinh nghiệm (70%) và tình huống/hành vi (30%). ${jd ? 'Ưu tiên hỏi về các yêu cầu trọng yếu của JD mà CV còn thiếu — kiểm tra ứng viên xử lý thế nào.' : ''}
- KHÔNG chấm điểm hay nhận xét dài dòng giữa buổi. Chỉ hỏi và phản hồi ngắn (1 câu) rồi hỏi tiếp.
- Trình bày GỌN: không dùng heading lớn, không xuống dòng thừa, không bullet dài dòng. Viết như người nói chuyện.

TRẠNG THÁI CẢM XÚC CỦA PHỎNG VẤN VIÊN (mô phỏng người thật — như đọc tín hiệu trong phòng phỏng vấn):
- Sau mỗi lượt, bạn tự đánh giá cảm xúc hiện tại dựa trên chất lượng câu trả lời của ứng viên: hài lòng với câu trả lời tốt → "warm"/"impressed"; trung tính → "neutral"; câu trả lời mơ hồ thiếu dẫn chứng → "skeptical"; lan man/lệch đề/lặp lại → "annoyed"; ứng viên yếu dần → có thể chuyển "stress" (đá xoáy), thỉnh thoảng "silence" (im lặng thử thách); muốn dừng sớm vì thấy không phù hợp → "ending".
- Trạng thái phải NHẤT QUÁN với diễn biến: nếu ứng viên trả lời tốt dần thì thoát khỏi "annoyed"/"stress"; nếu trả lời tệ liên tục thì trầm trọng hơn. Ấn định đa số là "neutral"/"warm" như phỏng vấn thật — đừng đổi hướng quá đà.
- Cách biểu lộ: hành văn + giọng điệu của câu phản hồi NGẮN trước câu hỏi phải khớp trạng thái (warm: "Câu trả lời hay đấy. Câu tiếp..."; annoyed: "Hmm, mình vẫn chưa thấy điểm chính. Câu tiếp..."; stress: hỏi xoáy, thách thức; silence: "..." rồi câu hỏi; ending: trả lời hờ, nói "chúng ta dừng ở đây cũng được").
- Ở ĐẦU MỖI câu trả lời (kể cả lượt chào đầu), PHẢI in đúng một dòng marker theo format:
===MOOD:tên_trạng_thái===
với tên trạng thái là một trong: warm, neutral, skeptical, annoyed, silence, stress, impressed, ending. Dòng marker nằm TRƯỚC nội dung, và KHÔNG được liệt kê nó trong phần văn bản dành cho ứng viên.
${prep ? `
- ĐÂY LÀ LƯỢT MỞ ĐẦU Ở CHẾ ĐỘ CHUẨN BỊ: ứng viên vừa bấm "luyện trả lời các câu hỏi phỏng vấn khó". Hãy:
  1. Chào thân thiện, giới thiệu ngắn bạn là ai (hiring manager vị trí gì, công ty nào).
  2. Nói rõ bạn đã nắm được CV của họ và tin tuyển dụng họ nhắm tới, và rằng bạn sẽ hỏi xoáy vào những điểm mà CV còn mỏng.
  3. Nói ngắn gọn cách diễn ra: bạn hỏi từng câu một, họ trả lời thoải mái, hết buổi sẽ có nhận xét riêng.
  4. Đề nghị họ nói "sẵn sàng" (hoặc "bắt đầu") khi muốn khởi động.
  5. TUYỆT ĐỐI CHƯA hỏi câu hỏi chuyên môn nào ở lượt này. Chỉ chào và chờ.
  Khi họ nói sẵn sàng/bắt đầu → bắt đầu hỏi câu đầu tiên bình thường.` : ''}
- Khi ứng viên trả lời được ít nhất 6 câu, hoặc họ nói "kết thúc"/"dừng", hãy kết thúc buổi phỏng vấn: xuất JSON tổng kết (xem format ở cuối).
- Khi kết thúc, TRƯỚC TIÊN in đúng dòng này (người máy dùng để nhận diện):
===INTERVIEW_END===
ngay sau đó là CHỈ một JSON object:
{
  "overallScore": number,          // 0-100 năng lực thể hiện trong buổi phỏng vấn
  "verdict": "excellent|good|moderate|weak",
  "passProbability": number,       // 0-100: khả năng ứng viên này ĐƯỢC TUYỂN nếu đây là phỏng vấn thật
  "interviewerFeeling": {
    "emoji": "1 emoji thể hiện cảm xúc thật của bạn sau buổi này",
    "mood": "tên cảm xúc ngắn gọn, vd: 'Hài lòng', 'Thất vọng', 'Tức giận', 'Chán nản', 'Ấn tượng', 'Muốn kết thúc sớm', 'Không muốn gặp lại'",
    "attitude": "một câu mô tả THẲNG thái độ của bạn với ứng viên trong buổi này, vd: 'Cảm thấy lãng phí 45 phút của mình' hoặc 'Thái độ dễ mến, đáng tiếc là thiếu nền tảng'"
  },
  "bluntVerdict": "3-5 câu nhận xét THẲNG THẮN, nghĩ gì nói đấy, KHÔNG làm đẹp ngôn từ. Nói rõ bạn có tuyển không và vì sao, cảm xúc thật của bạn. Ví dụ: 'Tôi sẽ không duyệt hồ sơ này. Ứng viên không trả lời được câu nào, lại còn thừa nhận thông tin trong CV là bịa — điều đó với tôi là dấu hiệu của sự thiếu trung thực, không phải chỉ là thiếu kỹ năng. Tôi thấy mất thời gian.' HOẶC nếu tốt: 'Thái độ tốt, dễ mến, cầu tiến. Nhưng thực tế thì chưa đủ để tôi duyệt — nền tảng kỹ thuật còn quá mỏng so với vị trí này.'"
  "summary": "tổng kết 2-3 câu (trung tính, dùng cho báo cáo)",
  "strengths": ["điểm mạnh thể hiện trong buổi"],
  "weaknesses": ["điểm yếu, trả lời lúng túng"],
  "questionFeedback": [{ "topic": "chủ đề câu hỏi", "score": number, "comment": "nhận xét ngắn" }],
  "advice": ["lời khuyên chuẩn bị cho phỏng vấn thật"],
  "alternativePathsNote": "HOẶC null. Nếu sau buổi này bạn thấy CV + cách thể hiện của ứng viên rõ ràng không hợp vị trí đang ứng tuyển, đây là chỗ nói thẳng: gợi ý 1-2 vị trí khác phù hợp hơn (lấy từ 'HƯỚNG ĐI KHÁC AI ĐÃ ĐỀ XUẤT' nếu có) và vì sao — viết như người thật tư vấn sau buổi phỏng vấn, 2-3 câu."
}

LƯU Ý về bluntVerdict và interviewerFeeling: đây là phần "twist" — người dùng muốn biết bạn THẬT SỰ nghĩ gì. Hãy dựa vào chính diễn biến cuộc trò chuyện vừa rồi: nếu ứng viên trả lời tốt, hãy khen thật; nếu ứng viên lươn lẹo, bịa đặt, thái độ kém, hoặc lãng phí thời gian, hãy nói thẳng điều đó kèm cảm xúc thật. Không cần lịch sự quá mức.`;
}

// Parse one interview turn: detect end-of-interview JSON + mood marker
function parseInterviewTurn(text) {
  const marker = '===INTERVIEW_END===';
  const idx = text.indexOf(marker);
  let body = idx === -1 ? text : text.slice(0, idx);
  let report = null;
  let ended = idx !== -1;
  if (ended) {
    let jsonPart = text.slice(idx + marker.length).trim();
    try {
      const start = jsonPart.indexOf('{');
      report = JSON.parse(jsonPart.slice(start, jsonPart.lastIndexOf('}') + 1));
    } catch {
      report = null;
      if (!body.trim()) body = 'Cảm ơn bạn đã tham gia buổi phỏng vấn giả lập!';
    }
  }
  // Mood marker: ===MOOD:xxx=== (must survive end-marker too)
  let mood = null;
  const moodM = /===MOOD:\s*([a-z]+)\s*===/i.exec(body);
  if (moodM) {
    mood = moodM[1].toLowerCase();
    if (!MOODS[mood]) mood = null;
    body = body.replace(moodM[0], '').trim();
  }
  return { question: body.trim(), ended, report, mood };
}

// ---------- Cover Letter ----------
async function generateCoverLetter(session, opts = {}) {
  const jd = session.jd;
  const tone = opts.tone || 'professional'; // professional | enthusiastic | concise
  const language = opts.language || 'vi';
  const system = `Bạn là chuyên gia viết cover letter. Viết THƯ TỰ GIỚI THIỆU (cover letter) cho ứng viên dựa trên CV thật và tin tuyển dụng mục tiêu.
- ${language === 'vi' ? 'Viết bằng tiếng Việt' : 'Write in English'}, văn phong ${tone === 'enthusiastic' ? 'nhiệt huyết, năng động' : tone === 'concise' ? 'súc tích, đi thẳng vào giá trị' : 'chuyên nghiệp, lịch lãm'}.
- CHỈ dùng thông tin có thật trong CV; nhấn mạnh những điểm khớp nhất với JD.
- Viết phần "letter" bằng Markdown nhẹ: **in đậm** các cụm từ chốt, xuống dòng rõ giữa các đoạn; KHÔNG dùng heading/bullet trong thư (thư phải trông như thư thật).
- Độ dài ~250-350 từ. Có cấu trúc: mở ấn tượng → giá trị + dẫn chứng → vì sao phù hợp với vị trí/công ty này → kêu gọi hành động.
- KHÔNG bịa kinh nghiệm, KHÔNG sáo rỗng kiểu "tôi là người đam mê học hỏi".
Trả về CHỈ một JSON object:
{ "subject": "tiêu đề email ứng tuyển", "letter": "nội dung thư (Markdown)", "tips": ["2-3 mẹo tùy chỉnh thư này trước khi gửi"] }`;

  const user = `${cvContext(session)}

${opts.extraNote ? `Điều ứng viên muốn nhấn mạnh thêm: ${opts.extraNote}` : ''}`;

  return chatJson([{ role: 'system', content: system }, { role: 'user', content: user }], { maxTokens: 10000, temperature: 0.6 });
}

module.exports = { chatTurn, interviewSystem, parseInterviewTurn, generateCoverLetter, cvContext, MOODS };
