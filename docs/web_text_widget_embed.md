# Web Text Widget Embed

Add the widget to the dealer website where customers submit their mobile number:

```html
<script
  src="https://api.example.com/public/widget/text-us.js"
  data-api-base="https://api.example.com"
  data-dealer-name="American Harley-Davidson"
  data-privacy-url="https://www.example.com/privacy-policy"
  data-terms-url="https://www.example.com/terms-of-use"
  data-cookies-url="https://www.example.com/cookie-policy"
></script>
```

`data-privacy-url`, `data-terms-url`, and `data-cookies-url` are optional, but should point to the dealer website's public policy pages when available.

The widget displays the consent disclosure next to the Send button and submits that disclosure with the lead for audit context:

> By selecting Send, you agree that {dealer} may contact you at the number and email you provide by call, text, or email about your inquiry. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out or HELP for help.
