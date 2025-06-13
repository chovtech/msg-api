// utils/formatPhoneNumber.js
const { parsePhoneNumberFromString } = require('libphonenumber-js');

function formatPhoneNumber(rawNumber, defaultCountry = 'NG') {
  try {
    const phoneNumber = parsePhoneNumberFromString(rawNumber, defaultCountry);
    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.number.replace('+', ''); // WhatsApp prefers E.164 without '+'
    } else {
      return null; // Invalid number
    }
  } catch (error) {
    return null;
  }
}

module.exports = formatPhoneNumber;
