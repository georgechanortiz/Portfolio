const text = "George Ortiz"; // Replace this with your name
const typingSpeed = 100; // milliseconds per letter
let i = 0;

function typeWriter() {
  if (i < text.length) {
    document.getElementById("typed-text").innerHTML += text.charAt(i);
    i++;
    setTimeout(typeWriter, typingSpeed);
  }
}

window.onload = typeWriter;
