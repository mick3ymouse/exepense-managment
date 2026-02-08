document.addEventListener('DOMContentLoaded', function() {
    
    // Upload Interaction
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('fileElem');

    dropArea.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            document.querySelector('.file-msg').textContent = `${e.target.files.length} file selezionati`;
        }
    });

    // Chart.js implementation for Panoramica
    const ctx = document.getElementById('panoramicaChart').getContext('2d');
    const myChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Entrate', 'Uscite'],
            datasets: [{
                label: 'EUR',
                data: [467, 242],
                backgroundColor: [
                    '#4CAF50',
                    '#EF5350'
                ],
                borderWidth: 0,
                borderRadius: 4,
                barThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        display: true,
                        drawBorder: false
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });

});
