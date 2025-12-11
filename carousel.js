const slides = document.querySelectorAll('.carousel-slide');
const nextBtn = document.querySelector('.carousel-btn.next');
const prevBtn = document.querySelector('.carousel-btn.prev');
const carouselDots = document.querySelector('.carousel-dots');

let currentIndex = 0;
let isTransitioning = false;

// Dynamically generate dots based on number of slides
function generateDots() {
  carouselDots.innerHTML = '';
  slides.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.classList.add('dot');
    dot.dataset.index = i;
    if (i === currentIndex) {
      dot.classList.add('active');
    }
    dot.addEventListener('click', () => {
      if (!isTransitioning) {
        currentIndex = i;
        updateCarousel();
      }
    });
    carouselDots.appendChild(dot);
  });
}

function updateCarousel(instant = false) {
  if (isTransitioning && !instant) return;
  isTransitioning = true;
  
  const totalSlides = slides.length;
  
  slides.forEach((slide, i) => {
    slide.classList.remove('active', 'left', 'right');
    
    // Calculate relative position from current index
    let relativePos = i - currentIndex;
    
    // Normalize position for wrapping
    while (relativePos < -Math.floor(totalSlides / 2)) relativePos += totalSlides;
    while (relativePos > Math.floor(totalSlides / 2)) relativePos -= totalSlides;
    
    // Apply classes and transforms based on position
    if (relativePos === 0) {
      // Center slide (active)
      slide.classList.add('active');
      slide.style.transform = 'translateX(0) scale(1)';
      slide.style.filter = 'brightness(1)';
      slide.style.zIndex = '3';
      slide.style.opacity = '1';
    } else if (relativePos === -1) {
      // Left slide
      slide.classList.add('left');
      slide.style.transform = 'translateX(-120%)';
      slide.style.filter = 'brightness(0.4)';
      slide.style.zIndex = '1';
      slide.style.opacity = '1';
    } else if (relativePos === 1) {
      // Right slide
      slide.classList.add('right');
      slide.style.transform = 'translateX(120%)';
      slide.style.filter = 'brightness(0.4)';
      slide.style.zIndex = '1';
      slide.style.opacity = '1';
    } else {
      // Hidden slides - position them far away
      const direction = relativePos < 0 ? -1 : 1;
      slide.style.transform = `translateX(${direction * 300}%)`;
      slide.style.filter = 'brightness(0.4)';
      slide.style.zIndex = '0';
      slide.style.opacity = '0';
    }
  });
  
  // Update dots
  const dots = document.querySelectorAll('.dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === currentIndex);
  });
  
  // Allow next transition after animation completes
  setTimeout(() => {
    isTransitioning = false;
  }, 800);
}

// Initialize carousel
generateDots();
updateCarousel(true);

// Next button - move to next project
if (nextBtn) {
  nextBtn.addEventListener('click', () => {
    if (!isTransitioning) {
      currentIndex = (currentIndex + 1) % slides.length;
      updateCarousel();
    }
  });
}

// Previous button - move to previous project
if (prevBtn) {
  prevBtn.addEventListener('click', () => {
    if (!isTransitioning) {
      currentIndex = (currentIndex - 1 + slides.length) % slides.length;
      updateCarousel();
    }
  });
}

// Auto-advance every 5 seconds
setInterval(() => {
  if (!isTransitioning) {
    currentIndex = (currentIndex + 1) % slides.length;
    updateCarousel();
  }
}, 5000);