let currentSlides = {};

function toggleExpand(card) {
    const wasExpanded = card.classList.contains('expanded');
    
    // Close all other cards
    document.querySelectorAll('.project-card').forEach(c => {
        c.classList.remove('expanded');
    });

    // Toggle this card
    if (!wasExpanded) {
        card.classList.add('expanded');
        initSlideshow(card);
    }
}

function initSlideshow(card) {
    const slideshow = card.querySelector('.slideshow');
    if (!slideshow || currentSlides[slideshow]) return;

    currentSlides[slideshow] = 0;
    const indicators = card.querySelector('.slide-indicators');
    const slides = slideshow.querySelectorAll('.slide');

    // Create indicator dots
    indicators.innerHTML = '';
    slides.forEach((_, index) => {
        const indicator = document.createElement('div');
        indicator.className = 'indicator' + (index === 0 ? ' active' : '');
        indicator.onclick = () => goToSlide(slideshow, index);
        indicators.appendChild(indicator);
    });
}

function changeSlide(btn, direction) {
    const slideshow = btn.parentElement;
    const slides = slideshow.querySelectorAll('.slide');
    const indicators = slideshow.parentElement.querySelectorAll('.indicator');
    
    currentSlides[slideshow] = (currentSlides[slideshow] || 0) + direction;
    
    // Wrap around
    if (currentSlides[slideshow] >= slides.length) {
        currentSlides[slideshow] = 0;
    } else if (currentSlides[slideshow] < 0) {
        currentSlides[slideshow] = slides.length - 1;
    }

    updateSlideshow(slideshow, slides, indicators);
}

function goToSlide(slideshow, index) {
    const slides = slideshow.querySelectorAll('.slide');
    const indicators = slideshow.parentElement.querySelectorAll('.indicator');
    currentSlides[slideshow] = index;
    updateSlideshow(slideshow, slides, indicators);
}

function updateSlideshow(slideshow, slides, indicators) {
    const current = currentSlides[slideshow];
    
    // Update slide visibility
    slides.forEach((slide, index) => {
        slide.classList.toggle('active', index === current);
    });
    
    // Update indicator dots
    indicators.forEach((indicator, index) => {
        indicator.classList.toggle('active', index === current);
    });
}